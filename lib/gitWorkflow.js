'use strict'

const debug = require('debug')('lint-staged:git')
const path = require('path')

const chunkFiles = require('./chunkFiles')
const execGit = require('./execGit')
const { readFile, unlink, writeFile } = require('./file')

const MERGE_HEAD = 'MERGE_HEAD'
const MERGE_MODE = 'MERGE_MODE'
const MERGE_MSG = 'MERGE_MSG'

// In git status, renames are presented as `from` -> `to`.
// When diffing, both need to be taken into account, but in some cases on the `to`.
const RENAME = / -> /

/**
 * From list of files, split renames and flatten into two files `from` -> `to`.
 * @param {string[]} files
 * @param {Boolean} [includeRenameFrom=true] Whether or not to include the `from` renamed file, which is no longer on disk
 */
const processRenames = (files, includeRenameFrom = true) =>
  files.reduce((flattened, file) => {
    if (RENAME.test(file)) {
      const [from, to] = file.split(RENAME)
      if (includeRenameFrom) flattened.push(from)
      flattened.push(to)
    } else {
      flattened.push(file)
    }
    return flattened
  }, [])

const STASH = 'lint-staged automatic backup'

const PATCH_UNSTAGED = 'lint-staged_unstaged.patch'

const GIT_DIFF_ARGS = [
  '--binary', // support binary files
  '--unified=0', // do not add lines around diff for consistent behaviour
  '--no-color', // disable colors for consistent behaviour
  '--no-ext-diff', // disable external diff tools for consistent behaviour
  '--src-prefix=a/', // force prefix for consistent behaviour
  '--dst-prefix=b/', // force prefix for consistent behaviour
  '--patch' // output a patch that can be applied
]
const GIT_APPLY_ARGS = ['-v', '--whitespace=nowarn', '--recount', '--unidiff-zero']

const handleError = (error, ctx) => {
  ctx.gitError = true
  throw error
}

class GitWorkflow {
  constructor({ allowEmpty, gitConfigDir, gitDir, matchedFiles, maxArgLength }) {
    this.execGit = (args, options = {}) => execGit(args, { ...options, cwd: gitDir })
    this.deletedFiles = []
    this.gitConfigDir = gitConfigDir
    this.gitDir = gitDir
    this.unstagedDiff = null
    this.allowEmpty = allowEmpty
    this.matchedFiles = matchedFiles
    this.maxArgLength = maxArgLength

    /**
     * These three files hold state about an ongoing git merge
     * Resolve paths during constructor
     */
    this.mergeHeadFilename = path.resolve(gitConfigDir, MERGE_HEAD)
    this.mergeModeFilename = path.resolve(gitConfigDir, MERGE_MODE)
    this.mergeMsgFilename = path.resolve(gitConfigDir, MERGE_MSG)
  }

  /**
   * Get absolute path to file hidden inside .git
   * @param {string} filename
   */
  getHiddenFilepath(filename) {
    return path.resolve(this.gitConfigDir, `./${filename}`)
  }

  /**
   * Get name of backup stash
   */
  async getBackupStash(ctx) {
    const stashes = await this.execGit(['stash', 'list'])
    const index = stashes.split('\n').findIndex(line => line.includes(STASH))
    if (index === -1) {
      ctx.gitGetBackupStashError = true
      throw new Error('lint-staged automatic backup is missing!')
    }
    return `stash@{${index}}`
  }

  /**
   * Get a list of unstaged deleted files
   */
  async getDeletedFiles() {
    debug('Getting deleted files...')
    const lsFiles = await this.execGit(['ls-files', '--deleted'])
    const deletedFiles = lsFiles
      .split('\n')
      .filter(Boolean)
      .map(file => path.resolve(this.gitDir, file))
    debug('Found deleted files:', deletedFiles)
    return deletedFiles
  }

  /**
   * Save meta information about ongoing git merge
   */
  async backupMergeStatus() {
    debug('Backing up merge state...')
    await Promise.all([
      readFile(this.mergeHeadFilename).then(buffer => (this.mergeHeadBuffer = buffer)),
      readFile(this.mergeModeFilename).then(buffer => (this.mergeModeBuffer = buffer)),
      readFile(this.mergeMsgFilename).then(buffer => (this.mergeMsgBuffer = buffer))
    ])
    debug('Done backing up merge state!')
  }

  /**
   * Restore meta information about ongoing git merge
   */
  async restoreMergeStatus() {
    debug('Restoring merge state...')
    try {
      await Promise.all([
        this.mergeHeadBuffer && writeFile(this.mergeHeadFilename, this.mergeHeadBuffer),
        this.mergeModeBuffer && writeFile(this.mergeModeFilename, this.mergeModeBuffer),
        this.mergeMsgBuffer && writeFile(this.mergeMsgFilename, this.mergeMsgBuffer)
      ])
      debug('Done restoring merge state!')
    } catch (error) {
      debug('Failed restoring merge state with error:')
      debug(error)
      throw new Error('Merge state could not be restored due to an error!')
    }
  }

  /**
   * Get a list of all files with both staged and unstaged modifications.
   * Renames have special treatment, since the single status line includes
   * both the "from" and "to" filenames, where "from" is no longer on disk.
   */
  async getPartiallyStagedFiles() {
    debug('Getting partially staged files...')
    const status = await this.execGit(['status', '--porcelain'])
    const partiallyStaged = status
      .split('\n')
      .filter(line => {
        /**
         * See https://git-scm.com/docs/git-status#_short_format
         * The first letter of the line represents current index status,
         * and second the working tree
         */
        const [index, workingTree] = line
        return index !== ' ' && workingTree !== ' ' && index !== '?' && workingTree !== '?'
      })
      .map(line => line.substr(3)) // Remove first three letters (index, workingTree, and a whitespace)
    debug('Found partially staged files:', partiallyStaged)
    return partiallyStaged.length ? partiallyStaged : null
  }

  /**
   * Create a diff of partially staged files and backup stash if enabled.
   */
  async prepare(ctx, shouldBackup) {
    try {
      debug('Backing up original state...')

      // Get a list of files with bot staged and unstaged changes.
      // Unstaged changes to these files should be hidden before the tasks run.
      this.partiallyStagedFiles = await this.getPartiallyStagedFiles()

      if (this.partiallyStagedFiles) {
        ctx.hasPartiallyStagedFiles = true
        const unstagedPatch = this.getHiddenFilepath(PATCH_UNSTAGED)
        const files = processRenames(this.partiallyStagedFiles)
        await this.execGit(['diff', ...GIT_DIFF_ARGS, '--output', unstagedPatch, '--', ...files])
      }

      /**
       * If backup stash should be skipped, no need to continue
       */
      if (!shouldBackup) return

      // Get a list of unstaged deleted files, because certain bugs might cause them to reappear:
      // - in git versions =< 2.13.0 the `--keep-index` flag resurrects deleted files
      // - git stash can't infer RD or MD states correctly, and will lose the deletion
      this.deletedFiles = await this.getDeletedFiles()

      // the `git stash` clears metadata about a possible git merge
      // Manually check and backup if necessary
      await this.backupMergeStatus()

      // Save stash of original state
      await this.execGit(['stash', 'save', STASH])
      await this.execGit(['stash', 'apply', '--quiet', '--index', await this.getBackupStash()])

      // Restore meta information about ongoing git merge, cleared by `git stash`
      await this.restoreMergeStatus()

      // If stashing resurrected deleted files, clean them out
      await Promise.all(this.deletedFiles.map(file => unlink(file)))

      debug('Done backing up original state!')
    } catch (error) {
      handleError(error, ctx)
    }
  }

  /**
   * Remove unstaged changes to all partially staged files, to avoid tasks from seeing them
   */
  async hideUnstagedChanges(ctx) {
    try {
      const files = processRenames(this.partiallyStagedFiles, false)
      await this.execGit(['checkout', '--force', '--', ...files])
    } catch (error) {
      /**
       * `git checkout --force` doesn't throw errors, so it shouldn't be possible to get here.
       * If this does fail, the handleError method will set ctx.gitError and lint-staged will fail.
       */
      ctx.gitHideUnstagedChangesError = true
      handleError(error, ctx)
    }
  }

  /**
   * Applies back task modifications, and unstaged changes hidden in the stash.
   * In case of a merge-conflict retry with 3-way merge.
   */
  async applyModifications(ctx) {
    debug('Adding task modifications to index...')
    // `matchedFiles` includes staged files that lint-staged originally detected and matched against a task.
    // Add only these files so any 3rd-party edits to other files won't be included in the commit.
    const files = Array.from(this.matchedFiles)
    // Chunk files for better Windows compatibility
    const matchedFileChunks = chunkFiles({
      baseDir: this.gitDir,
      files,
      maxArgLength: this.maxArgLength
    })

    // These additions per chunk are run "serially" to prevent race conditions.
    // Git add creates a lockfile in the repo causing concurrent operations to fail.
    for (const files of matchedFileChunks) {
      await this.execGit(['add', '--', ...files])
    }

    debug('Done adding task modifications to index!')

    const stagedFilesAfterAdd = await this.execGit(['diff', '--name-only', '--cached'])
    if (!stagedFilesAfterAdd && !this.allowEmpty) {
      // Tasks reverted all staged changes and the commit would be empty
      // Throw error to stop commit unless `--allow-empty` was used
      ctx.gitApplyEmptyCommitError = true
      handleError(new Error('Prevented an empty git commit!'), ctx)
    }
  }

  /**
   * Restore unstaged changes to partially changed files. If it at first fails,
   * this is probably because of conflicts between new task modifications.
   * 3-way merge usually fixes this, and in case it doesn't we should just give up and throw.
   */
  async restoreUnstagedChanges(ctx) {
    debug('Restoring unstaged changes...')
    const unstagedPatch = this.getHiddenFilepath(PATCH_UNSTAGED)
    try {
      await this.execGit(['apply', ...GIT_APPLY_ARGS, unstagedPatch])
    } catch (applyError) {
      debug('Error while restoring changes:')
      debug(applyError)
      debug('Retrying with 3-way merge')
      try {
        // Retry with a 3-way merge if normal apply fails
        await this.execGit(['apply', ...GIT_APPLY_ARGS, '--3way', unstagedPatch])
      } catch (threeWayApplyError) {
        debug('Error while restoring unstaged changes using 3-way merge:')
        debug(threeWayApplyError)
        ctx.gitRestoreUnstagedChangesError = true
        handleError(
          new Error('Unstaged changes could not be restored due to a merge conflict!'),
          ctx
        )
      }
    }
  }

  /**
   * Restore original HEAD state in case of errors
   */
  async restoreOriginalState(ctx) {
    try {
      debug('Restoring original state...')
      await this.execGit(['reset', '--hard', 'HEAD'])
      await this.execGit(['stash', 'apply', '--quiet', '--index', await this.getBackupStash(ctx)])

      // Restore meta information about ongoing git merge
      await this.restoreMergeStatus()

      // If stashing resurrected deleted files, clean them out
      await Promise.all(this.deletedFiles.map(file => unlink(file)))

      // Clean out patch
      if (this.partiallyStagedFiles) await unlink(PATCH_UNSTAGED)

      debug('Done restoring original state!')
    } catch (error) {
      ctx.gitRestoreOriginalStateError = true
      handleError(error, ctx)
    }
  }

  /**
   * Drop the created stashes after everything has run
   */
  async cleanup(ctx) {
    try {
      debug('Dropping backup stash...')
      await this.execGit(['stash', 'drop', '--quiet', await this.getBackupStash(ctx)])
      debug('Done dropping backup stash!')
    } catch (error) {
      handleError(error, ctx)
    }
  }
}

module.exports = GitWorkflow
