/**
 * In-memory vault store for the browser mock (§5.12, LOA-64). Content hashes
 * are modeled with the same SHAPE as native (hex strings compared for
 * equality) — the algorithm differs (FNV-1a here, blake3 natively), which is
 * fine: hashes are opaque tokens at the contract boundary.
 */

export interface MockVaultFixture {
  /** Absolute-looking path used to open the vault (opaque to the mock). */
  path?: string;
  name?: string;
  readOnly?: boolean;
  /** Initial notes: vault-relative path → content. */
  files?: Record<string, string>;
}

/** Deterministic FNV-1a 64-bit hex hash. */
export function mockHash(content: string): string {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < content.length; index += 1) {
    low ^= content.charCodeAt(index);
    // 64-bit FNV prime multiply, split into 32-bit halves.
    const newLow = (low & 0xffff) * 0x1b3 + (((low >>> 16) * 0x1b3) << 16);
    high = (high * 0x1b3 + ((low * 0x100) % 0x100000000) + (newLow > 0xffffffff ? 1 : 0)) >>> 0;
    low = newLow >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

export class MockVaultStore {
  readonly id: string;
  readonly name: string;
  readonly readOnly: boolean;
  private readonly files = new Map<string, string>();

  constructor(id: string, fixture: MockVaultFixture) {
    this.id = id;
    this.name = fixture.name ?? "Mock Vault";
    this.readOnly = fixture.readOnly ?? false;
    for (const [path, content] of Object.entries(fixture.files ?? {})) {
      this.files.set(path, content);
    }
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  hashOf(path: string): string | undefined {
    const content = this.files.get(path);
    return content === undefined ? undefined : mockHash(content);
  }

  write(path: string, content: string): string {
    this.files.set(path, content);
    return mockHash(content);
  }

  remove(path: string): boolean {
    return this.files.delete(path);
  }

  rename(from: string, to: string): void {
    const content = this.files.get(from);
    if (content !== undefined) {
      this.files.delete(from);
      this.files.set(to, content);
    }
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  counts(): { notes: number; folders: number; attachments: number } {
    const folders = new Set<string>();
    let notes = 0;
    let attachments = 0;
    for (const path of this.files.keys()) {
      const segments = path.split("/");
      for (let depth = 1; depth < segments.length; depth += 1) {
        folders.add(segments.slice(0, depth).join("/"));
      }
      if (path.endsWith(".md")) {
        notes += 1;
      } else {
        attachments += 1;
      }
    }
    return { notes, folders: folders.size, attachments };
  }

  /** Native collision policy: `Title.md`, `Title 2.md`, `Title 3.md`… */
  uniqueName(folder: string, title: string, extension: string | null): string {
    const join = (name: string) => (folder === "" ? name : `${folder}/${name}`);
    const withExtension = (name: string) => (extension ? `${name}.${extension}` : name);
    if (!this.files.has(join(withExtension(title)))) {
      return join(withExtension(title));
    }
    for (let candidate = 2; ; candidate += 1) {
      const name = join(withExtension(`${title} ${candidate}`));
      if (!this.files.has(name)) {
        return name;
      }
    }
  }
}
