import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type VoiceTranscodeOptions = {
  ffmpegPath?: string;
  bitrateKbps?: number;
  sampleRate?: number;
};

const DEFAULT_FFMPEG_PATH = "ffmpeg";
const DEFAULT_BITRATE_KBPS = 96;
const DEFAULT_SAMPLE_RATE = 48_000;

export async function transcodeWavToOggOpus(
  inputPath: string,
  outputPath: string,
  options: VoiceTranscodeOptions = {},
): Promise<void> {
  const ffmpegPath = options.ffmpegPath?.trim() || DEFAULT_FFMPEG_PATH;
  const bitrateKbps = Math.max(32, Math.min(192, Math.round(options.bitrateKbps ?? DEFAULT_BITRATE_KBPS)));
  const sampleRate = Math.max(8_000, Math.min(48_000, Math.round(options.sampleRate ?? DEFAULT_SAMPLE_RATE)));

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const args = [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-map_metadata",
    "-1",
    "-c:a",
    "libopus",
    "-b:a",
    `${bitrateKbps}k`,
    "-vbr",
    "on",
    "-compression_level",
    "10",
    "-application",
    "audio",
    "-ar",
    String(sampleRate),
    "-ac",
    "1",
    outputPath,
  ];

  await runProcess(ffmpegPath, args);
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
      reject(new Error(`ffmpeg 转码失败: ${detail}`));
    });
  });
}
