/**
 * KAOS 文件状态结果，对应 Python 的 os.stat_result 字段。
 *
 * 包含文件的 inode 元数据：类型/权限、inode 编号、设备号、硬链接数、
 * 所有者 uid/gid、大小以及三个时间戳（访问/修改/创建）。
 */
export interface StatResult {
  /** 文件类型和权限位（POSIX st_mode） */
  stMode: number;
  /** inode 编号（SFTP 等远程文件系统下可能为 0） */
  stIno: number;
  /** 设备编号（SFTP 下为 0） */
  stDev: number;
  /** 硬链接数量（SFTP 下为 0） */
  stNlink: number;
  /** 所有者用户 ID */
  stUid: number;
  /** 所有者组 ID */
  stGid: number;
  /** 文件大小（字节） */
  stSize: number;
  /** 最后访问时间（Unix 时间戳，秒） */
  stAtime: number;
  /** 最后修改时间（Unix 时间戳，秒） */
  stMtime: number;
  /** 创建时间 / 状态变更时间（Unix 时间戳，秒；SFTP v3 回退到 mtime） */
  stCtime: number;
}
