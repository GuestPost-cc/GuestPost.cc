import { spawn } from "node:child_process"
import process from "node:process"

export interface ExecOptions {
  stdio?: "pipe" | "inherit"
}

export function $(
  cmd: string,
  args: string[],
  options: ExecOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: options.stdio ?? "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, FORCE_COLOR: "1" },
    })
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
    child.on("error", reject)
  })
}
