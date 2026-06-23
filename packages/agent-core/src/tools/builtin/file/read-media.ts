/**
 * ReadMediaFileTool — 以多模态内容形式读取图片/视频文件。
 *
 * 返回 4 部分包装：
 * `[TextPart('<system>…</system>'), TextPart('<image|video path="…">'),
 *   ImageContent|VideoContent, TextPart('</image|video>')]`
 * 并根据模型的 `image_in` / `video_in` 能力进行门控。
 *
 * 开头的 `<system>` 块汇总 mime 类型、字节大小和（对图片）原始像素尺寸，
 * 指导模型从该原始尺寸推导绝对坐标，并提醒模型重新读取其生成或编辑的
 * 任何媒体。
 *
 * 路径安全：使用 Read/Write/Edit 共享的路径访问解析器。
 */

import type { Kaos } from '@moonshot-ai/kaos';
import type {
  ContentPart,
  ModelCapability,
  VideoURLPart,
  VideoUploadInput as ProviderVideoUploadInput,
} from '@moonshot-ai/kosong';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import { ToolAccesses } from '../../../loop/tool-access';
import type { ExecutableToolResult, ToolExecution } from '../../../loop/types';
import { renderPrompt } from '../../../utils/render-prompt';
import { resolvePathAccessPath } from '../../policies/path-access';
import { MEDIA_SNIFF_BYTES, detectFileType, sniffImageDimensions } from '../../support/file-type';
import { toInputJsonSchema } from '../../support/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '../../support/rule-match';
import type { WorkspaceConfig } from '../../support/workspace';
import readMediaDescriptionHead from './read-media.md?raw';

// ── 常量 ────────────────────────────────────────────────────────

const MAX_MEDIA_MEGABYTES = 100;
const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;

export type VideoUploadInput = ProviderVideoUploadInput;

export type VideoUploader = (input: VideoUploadInput) => Promise<VideoURLPart>;

// ── 输入 schema ─────────────────────────────────────────────────────

export const ReadMediaFileInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to an image or video file. Relative paths resolve against the working directory; ' +
        'a path outside the working directory must be absolute. ' +
        'Directories and text files are not supported.',
    ),
});

export type ReadMediaFileInput = z.Infer<typeof ReadMediaFileInputSchema>;

// ── 工具描述（基于能力）─────────────────────────────────────────────

function buildDescription(capabilities: ModelCapability): string {
  const head = renderPrompt(readMediaDescriptionHead, { MAX_MEDIA_MEGABYTES });
  const lines: string[] = [head];
  const hasImage = capabilities.image_in;
  const hasVideo = capabilities.video_in;
  if (hasImage && hasVideo) {
    lines.push('- This tool supports image and video files for the current model.');
  } else if (hasImage) {
    lines.push(
      '- This tool supports image files for the current model.',
      '- Video files are not supported by the current model.',
    );
  } else if (hasVideo) {
    lines.push(
      '- This tool supports video files for the current model.',
      '- Image files are not supported by the current model.',
    );
  } else {
    lines.push('- The current model does not support image or video input.');
  }
  return lines.join('\n');
}

// ── 系统摘要 ───────────────────────────────────────────────────

/**
 * 构建媒体内容之前的 `<system>` 摘要。
 *
 * 携带 mime 类型、字节大小和（对图片）原始像素尺寸。当尺寸已知时，
 * 还指导模型从该原始尺寸推导绝对坐标；始终提醒模型重新读取其
 * 生成或编辑的任何媒体。
 */
function buildSystemSummary(input: {
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  readonly byteSize: number;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
}): string {
  const parts: string[] = [
    `Read ${input.kind} file.`,
    `Mime type: ${input.mimeType}.`,
    `Size: ${String(input.byteSize)} bytes.`,
  ];
  // 坐标指导仅在原始尺寸确实已知时才发出 — 对某些图片格式
  // （TIFF/ICO/HEIC/…）嗅探会失败，告诉模型使用不在块中的尺寸
  // 会误导它。
  if (input.kind === 'image' && input.dimensions) {
    parts.push(
      `Original dimensions: ${String(input.dimensions.width)}x${String(input.dimensions.height)} pixels.`,
      'If you need to output coordinates, output relative coordinates first ' +
        'and compute absolute coordinates using the original image size.',
    );
  }
  parts.push(
    'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.',
  );
  return `<system>${parts.join(' ')}</system>`;
}

// ── 实现 ───────────────────────────────────────────────────

export class ReadMediaFileTool implements BuiltinTool<ReadMediaFileInput> {
  readonly name = 'ReadMediaFile' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadMediaFileInputSchema);
  constructor(
    private readonly kaos: Kaos,
    private readonly workspace: WorkspaceConfig,
    private readonly capabilities: ModelCapability,
    private readonly videoUploader?: VideoUploader | undefined,
  ) {
    if (!capabilities.image_in && !capabilities.video_in) {
      const skip = new Error('ReadMediaFile requires image_in or video_in capability');
      skip.name = 'SkipThisTool';
      throw skip;
    }
    this.description = buildDescription(capabilities);
  }

  resolveExecution(args: ReadMediaFileInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      kaos: this.kaos,
      workspace: this.workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading media: ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: this.kaos.pathClass(),
          homeDir: this.kaos.gethome(),
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(
    args: ReadMediaFileInput,
    safePath: string,
  ): Promise<ExecutableToolResult> {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }

    try {
      // 对于媒体输入，字节是权威来源；扩展名仅作为无法从头部
      // 嗅探的格式的后备。
      const header = await this.kaos.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header, 'media');

      if (fileType.kind === 'text') {
        return {
          isError: true,
          output: `"${args.path}" is a text file. Use Read to read text files.`,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output:
            `"${args.path}" is not a supported image or video file. ` +
            'Use Read for text files, or Bash or an MCP tool for other binary formats.',
        };
      }

      if (fileType.kind === 'image' && !this.capabilities.image_in) {
        return {
          isError: true,
          output:
            'The current model does not support image input. ' +
            'Tell the user to use a model with image input capability.',
        };
      }
      if (fileType.kind === 'video' && !this.capabilities.video_in) {
        return {
          isError: true,
          output:
            'The current model does not support video input. ' +
            'Tell the user to use a model with video input capability.',
        };
      }

      const stat = await this.kaos.stat(safePath);
      if (stat.stSize === 0) {
        return { isError: true, output: `"${args.path}" is empty.` };
      }
      if (stat.stSize > MAX_MEDIA_BYTES) {
        return {
          isError: true,
          output:
            `"${args.path}" is ${String(stat.stSize)} bytes, which exceeds the ` +
            `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
        };
      }

      const data = await this.kaos.readBytes(safePath);
      const base64 = data.toString('base64');
      let mediaPart: ContentPart;
      if (fileType.kind === 'image') {
        mediaPart = {
          type: 'image_url',
          imageUrl: { url: `data:${fileType.mimeType};base64,${base64}` },
        };
      } else if (this.videoUploader !== undefined) {
        mediaPart = await this.videoUploader({
          data,
          mimeType: fileType.mimeType,
          filename: safePath.split(/[\\/]/).at(-1),
        });
      } else {
        mediaPart = {
          type: 'video_url',
          videoUrl: { url: `data:${fileType.mimeType};base64,${base64}` },
        };
      }

      const tag = fileType.kind === 'image' ? 'image' : 'video';
      const openText = `<${tag} path="${safePath}">`;
      const closeText = `</${tag}>`;

      const dimensions =
        fileType.kind === 'image' ? sniffImageDimensions(data) : null;
      const systemText = buildSystemSummary({
        kind: fileType.kind,
        mimeType: fileType.mimeType,
        byteSize: stat.stSize,
        dimensions,
      });

      const output: ContentPart[] = [
        { type: 'text', text: systemText },
        { type: 'text', text: openText },
        mediaPart,
        { type: 'text', text: closeText },
      ];

      return { output, isError: false };
    } catch (error) {
      return {
        isError: true,
        output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
