/**
 * Mock for Obsidian API
 * 
 * Provides minimal mock implementations of Obsidian classes and functions
 * needed for unit testing.
 */

export class Notice {
    message: string;

    constructor(message: string) {
        this.message = message;
    }
}

export class Plugin {
    app!: App;
    manifest!: PluginManifest;

    async loadData(): Promise<unknown> {
        return {};
    }

    async saveData(_data: unknown): Promise<void> {
        // Mock save
    }

    addCommand(_command: Command): void {
        // Mock command registration
    }

    addRibbonIcon(_icon: string, _title: string, _callback: () => void): HTMLElement {
        return document.createElement('div');
    }

    addSettingTab(_tab: unknown): void {
        // Mock setting tab
    }

    registerInterval(_id: number): number {
        return _id;
    }
}

export class App {
    vault!: Vault;
    workspace!: Workspace;
}

export class Vault {
    private files: Map<string, MockFile> = new Map();

    getName(): string {
        return 'TestVault';
    }

    getFiles(): TFile[] {
        return Array.from(this.files.values()) as TFile[];
    }

    async read(file: TFile): Promise<string> {
        return (file as MockFile).content || '';
    }

    async readBinary(file: TFile): Promise<ArrayBuffer> {
        const content = (file as MockFile).content || '';
        return new TextEncoder().encode(content).buffer;
    }

    async create(path: string, data: string): Promise<TFile> {
        const file = new MockFile(path, data);
        this.files.set(path, file);
        return file as TFile;
    }

    async modify(file: TFile, data: string): Promise<void> {
        (file as MockFile).content = data;
    }

    async delete(file: TFile): Promise<void> {
        this.files.delete(file.path);
    }

    // Helper for tests
    _addFile(path: string, content: string): TFile {
        const file = new MockFile(path, content);
        this.files.set(path, file);
        return file as TFile;
    }

    _clear(): void {
        this.files.clear();
    }
}

export class Workspace {
    on(_name: string, _callback: (...args: unknown[]) => void): void {
        // Mock event listener
    }
}

export abstract class TFile {
    path!: string;
    name!: string;
    basename!: string;
    extension!: string;
    stat!: FileStats;
}

export abstract class TFolder {
    path!: string;
    name!: string;
}

export interface FileStats {
    ctime: number;
    mtime: number;
    size: number;
}

export interface PluginManifest {
    id: string;
    name: string;
    version: string;
    minAppVersion: string;
    description: string;
    author: string;
}

export interface Command {
    id: string;
    name: string;
    callback?: () => void;
    checkCallback?: (checking: boolean) => boolean;
}

// Mock file implementation for testing
class MockFile extends TFile {
    content: string;

    constructor(path: string, content: string = '') {
        super();
        this.path = path;
        this.content = content;

        const parts = path.split('/');
        this.name = parts[parts.length - 1];

        const dotIndex = this.name.lastIndexOf('.');
        if (dotIndex > 0) {
            this.basename = this.name.substring(0, dotIndex);
            this.extension = this.name.substring(dotIndex + 1);
        } else {
            this.basename = this.name;
            this.extension = '';
        }

        this.stat = {
            ctime: Date.now(),
            mtime: Date.now(),
            size: content.length,
        };
    }
}

// Mock requestUrl for S3 operations
export interface RequestUrlParam {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
    throw?: boolean;
}

export interface RequestUrlResponse {
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
    text: string;
    json: unknown;
}

export async function requestUrl(_params: RequestUrlParam): Promise<RequestUrlResponse> {
    // Mock implementation - can be overridden in tests
    return {
        status: 200,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: '',
        json: {},
    };
}
