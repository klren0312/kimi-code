export type ToolFileAccessOperation = 'read' | 'write' | 'readwrite' | 'search';

export interface ToolFileAccess {
  readonly kind: 'file';
  readonly operation: ToolFileAccessOperation;
  readonly path: string;
  readonly recursive?: boolean;
}

export interface ToolResourceAccessAll {
  /**
   * 无法表示为文件访问的任意副作用或资源。
   * 此类型故意不包含操作类型，并且在并发方面是全局排他的。
   */
  readonly kind: 'all';
}

export type ToolResourceAccess = ToolFileAccess | ToolResourceAccessAll;
export type ToolAccesses = readonly ToolResourceAccess[];

export const ToolAccesses = {
  none(): ToolAccesses {
    return [];
  },

  all(): ToolAccesses {
    return [{ kind: 'all' }];
  },

  file(
    operation: ToolFileAccessOperation,
    path: string,
    options: { readonly recursive?: boolean } = {},
  ): ToolAccesses {
    return [{ kind: 'file', operation, path, recursive: options.recursive }];
  },

  readFile(path: string): ToolAccesses {
    return ToolAccesses.file('read', path);
  },

  readTree(path: string): ToolAccesses {
    return ToolAccesses.file('read', path, { recursive: true });
  },

  writeFile(path: string): ToolAccesses {
    return ToolAccesses.file('write', path);
  },

  writeTree(path: string): ToolAccesses {
    return ToolAccesses.file('write', path, { recursive: true });
  },

  readWriteFile(path: string): ToolAccesses {
    return ToolAccesses.file('readwrite', path);
  },

  readWriteTree(path: string): ToolAccesses {
    return ToolAccesses.file('readwrite', path, { recursive: true });
  },

  searchTree(path: string): ToolAccesses {
    return ToolAccesses.file('search', path, { recursive: true });
  },

  conflict(left: ToolAccesses, right: ToolAccesses): boolean {
    return left.some((leftAccess) =>
      right.some((rightAccess) => resourceAccessesConflict(leftAccess, rightAccess)),
    );
  },
};

function resourceAccessesConflict(left: ToolResourceAccess, right: ToolResourceAccess): boolean {
  if (left.kind === 'all' || right.kind === 'all') return true;
  if (!fileOperationsConflict(left.operation, right.operation)) return false;
  return fileAccessesOverlap(left, right);
}

function fileOperationsConflict(
  left: ToolFileAccessOperation,
  right: ToolFileAccessOperation,
): boolean {
  return fileOperationWrites(left) || fileOperationWrites(right);
}

function fileOperationWrites(operation: ToolFileAccessOperation): boolean {
  switch (operation) {
    case 'read':
    case 'search':
      return false;
    case 'write':
    case 'readwrite':
      return true;
  }
}

function fileAccessesOverlap(left: ToolFileAccess, right: ToolFileAccess): boolean {
  const leftPath = normalizePath(left.path);
  const rightPath = normalizePath(right.path);
  if (leftPath === rightPath) return true;

  const leftPrefix = leftPath.endsWith('/') ? leftPath : `${leftPath}/`;
  const rightPrefix = rightPath.endsWith('/') ? rightPath : `${rightPath}/`;
  return (
    (left.recursive === true && rightPath.startsWith(leftPrefix)) ||
    (right.recursive === true && leftPath.startsWith(rightPrefix))
  );
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replaceAll(/\/+/g, '/');
  const folded = normalized.toLowerCase();
  if (folded.length > 1 && folded.endsWith('/')) {
    return folded.slice(0, -1);
  }
  return folded;
}
