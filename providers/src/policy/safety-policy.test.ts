import { describe, expect, it } from "vitest";
import { checkCommand, SafetyPolicy } from "./safety-policy.ts";
import { sandboxed, seatbeltProfile } from "./seatbelt.ts";

const policy = new SafetyPolicy({
  home: "/Users/flo",
  protectedPaths: ["/Users/flo/Library/Application Support/bench_bot", "/Users/flo/code/bench_bot"],
});
const ctx = {
  botId: "finance",
  workspacePath: "/Users/flo/Library/Application Support/bench_bot/workspaces/finance",
};
const write = (path: string) => policy.check({ kind: "write", path }, ctx);

describe("folder limits", () => {
  it.each([
    ["the bot's own workspace", `${ctx.workspacePath}/report.md`],
    ["normal user folders", "/Users/flo/Documents/budget.xlsx"],
    ["the Desktop", "/Users/flo/Desktop/note.txt"],
    ["temp folders", "/tmp/x"],
    ["Homebrew", "/usr/local/bin/tool"],
    ["external disks", "/Volumes/USB/file"],
  ])("allows writing in %s", (_label, path) => {
    expect(write(path)).toEqual({ allow: true });
  });

  it.each([
    ["macOS system folders", "/System/Library/x", "system folders are protected"],
    ["/Library", "/Library/LaunchDaemons/evil.plist", "system folders are protected"],
    ["/usr/bin", "/usr/bin/ls", "system folders are protected"],
    ["/etc", "/etc/hosts", "system folders are protected"],
    ["/Applications", "/Applications/Safari.app/x", "system folders are protected"],
    [
      "another bot's workspace",
      "/Users/flo/Library/Application Support/bench_bot/workspaces/orchestrator/x",
      "bench_bot's own program and data are protected",
    ],
    [
      "the bench_bot database",
      "/Users/flo/Library/Application Support/bench_bot/bench.db",
      "bench_bot's own program and data are protected",
    ],
    [
      "the bench_bot program",
      "/Users/flo/code/bench_bot/bots/finance.yaml",
      "bench_bot's own program and data are protected",
    ],
    [
      "the keychain",
      "/Users/flo/Library/Keychains/login.keychain-db",
      "~/Library/Keychains is protected (keychain and login items)",
    ],
    [
      "login items",
      "/Users/flo/Library/LaunchAgents/x.plist",
      "~/Library/LaunchAgents is protected (keychain and login items)",
    ],
    ["the disk root", "/", "the top of the disk and the home folder itself are protected"],
  ])("refuses writing to %s", (_label, path, reason) => {
    expect(write(path)).toEqual({ allow: false, reason });
  });

  it("allows reading anything", () => {
    expect(policy.check({ kind: "read", path: "/etc/hosts" }, ctx)).toEqual({ allow: true });
  });
});

describe("command block list", () => {
  it.each([
    "sudo rm -rf /tmp/x",
    "echo hi && sudo reboot",
    "su -",
    "su root",
    "rm -rf /",
    "rm -rf ~",
    "rm -rf ~/*",
    "rm -fr $HOME",
    'rm -rf "/System"',
    "rm -rf /Users",
    "diskutil eraseDisk APFS X disk2",
    "diskutil apfs deleteContainer disk3",
    "dd if=/dev/zero of=/dev/disk2",
    "mkfs.ext4 /dev/sdb1",
    "shutdown -h now",
    "reboot",
    "csrutil disable",
    "nvram boot-args=-v",
    "sudo spctl --master-disable",
    "launchctl bootout system/com.apple.x",
    "pmset sleepnow",
    "tmutil deletelocalsnapshots /",
    "chmod -R 777 /",
    "chown -R me /usr",
    ":(){ :|:& };:",
    "killall Finder",
    "kill -9 1",
    "ls; sudo ls",
    "x=$(sudo whoami)",
    "env FOO=1 sudo ls",
    "xargs -0 sudo rm",
    "true && reboot",
  ])("refuses %s", (command) => {
    expect(checkCommand(command).allow).toBe(false);
  });

  it.each([
    "ls -la",
    "git status",
    "rm -rf build/",
    "rm -rf ./node_modules",
    "rm notes.txt",
    "rm -rf ~/Downloads/old-stuff",
    "npm run build",
    "python3 analyse.py --sum",
    "echo pseudo-code",
    "cat /etc/hosts",
    "grep -r reboot docs/",
    "grep -rn sudo scripts/",
    "echo shutdown is not allowed",
    "chmod +x script.sh",
    "dd if=a.img of=b.img",
    "launchctl list",
    "summary.sh",
  ])("allows %s", (command) => {
    expect(checkCommand(command)).toEqual({ allow: true });
  });

  it("works through the policy service", () => {
    expect(policy.check({ kind: "command", command: "sudo ls", cwd: "/" }, ctx)).toEqual({
      allow: false,
      reason: "admin rights (sudo) are not allowed",
    });
  });
});

describe("macOS sandbox", () => {
  it("denies the protected places and re-allows the workspace, in that order", () => {
    const profile = seatbeltProfile(policy.sandboxPaths(ctx.workspacePath));
    const deny = profile.indexOf("(deny file-write*");
    const allow = profile.indexOf("(allow file-write*");
    expect(profile.startsWith("(version 1)\n(allow default)")).toBe(true);
    expect(deny).toBeGreaterThan(0);
    expect(allow).toBeGreaterThan(deny);
    expect(profile).toContain('(subpath "/System")');
    expect(profile).toContain('(subpath "/Users/flo/code/bench_bot")');
    expect(profile.slice(allow)).toContain(`(subpath "${ctx.workspacePath}")`);
    expect(profile).toContain('(literal "/dev/null")');
  });

  it("escapes quotes in paths", () => {
    expect(seatbeltProfile({ denied: ['/a"b'], allowed: [] })).toContain('(subpath "/a\\"b")');
  });

  it("wraps commands with sandbox-exec on macOS only", () => {
    const paths = { denied: ["/System"], allowed: ["/w"] };
    const mac = sandboxed("opencode", ["acp"], paths, "darwin");
    expect(mac.command).toBe("/usr/bin/sandbox-exec");
    expect(mac.args.slice(0, 1)).toEqual(["-p"]);
    expect(mac.args.slice(2)).toEqual(["opencode", "acp"]);
    expect(mac.confined).toBe(true);
    expect(sandboxed("opencode", ["acp"], paths, "linux")).toEqual({
      command: "opencode",
      args: ["acp"],
      confined: false,
    });
  });
});
