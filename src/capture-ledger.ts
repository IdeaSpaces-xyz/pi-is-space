import type { PathRevision, SelectedPathRevision } from "@ideaspaces/protocol";

function key(root: string, path: string): string {
  return `${root}\0${path}`;
}

interface LedgerEntry {
  root: string;
  path: string;
  revision: PathRevision;
}

/**
 * Process-local capture ownership for one Pi extension session.
 *
 * Captures are eligible for `is_commit({ all: true })`; review snapshots only
 * preserve the full revision behind the legacy worktree-SHA `if_match` token.
 * Neither kind is persisted or written into the user's repository.
 */
export class SessionCaptureLedger {
  private readonly captures = new Map<string, LedgerEntry>();
  private readonly reviews = new Map<string, LedgerEntry>();

  recordReview(root: string, path: string, revision: PathRevision): void {
    this.reviews.set(key(root, path), { root, path, revision });
  }

  recordCapture(root: string, path: string, revision: PathRevision): void {
    const entry = { root, path, revision };
    this.captures.set(key(root, path), entry);
    this.reviews.set(key(root, path), entry);
  }

  capturedRevision(root: string, path: string): PathRevision | undefined {
    return this.captures.get(key(root, path))?.revision;
  }

  /** Full reviewed revision corresponding to a legacy worktree object id. */
  reviewedRevision(
    root: string,
    path: string,
    worktreeOid: string,
  ): PathRevision | undefined {
    const captured = this.captures.get(key(root, path))?.revision;
    if (captured?.worktree === worktreeOid) return captured;
    const reviewed = this.reviews.get(key(root, path))?.revision;
    return reviewed?.worktree === worktreeOid ? reviewed : undefined;
  }

  capturedPaths(root: string): string[] {
    return [...this.captures.values()]
      .filter((entry) => entry.root === root)
      .map((entry) => entry.path)
      .sort();
  }

  refreshCaptured(root: string, revisions: SelectedPathRevision[]): void {
    for (const { path, revision } of revisions) {
      if (this.captures.has(key(root, path))) this.recordCapture(root, path, revision);
    }
  }

  removeCaptured(root: string, paths: string[]): void {
    for (const path of paths) this.captures.delete(key(root, path));
  }
}
