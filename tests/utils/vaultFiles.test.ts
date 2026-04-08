jest.mock('obsidian');

import { TFile, Vault } from 'obsidian';
import { getVaultFileKind, readVaultFile, toArrayBuffer } from '../../src/utils/vaultFiles';

class MockTFile extends TFile {}

function createFile(path: string): TFile {
    const file = new MockTFile();
    file.path = path;
    return file;
}

describe('vaultFiles', () => {
    describe('getVaultFileKind', () => {
        it.each(['note.md', 'data.json', 'table.csv', 'diagram.svg', 'script.ts'])('returns text for %s', (path) => {
            expect(getVaultFileKind(path)).toBe('text');
        });

        it.each(['image.png', 'photo.jpg', 'document.pdf'])('returns binary for %s', (path) => {
            expect(getVaultFileKind(path)).toBe('binary');
        });

        it('returns text when there is no extension', () => {
            expect(getVaultFileKind('README')).toBe('text');
        });
    });

    describe('readVaultFile', () => {
        it('reads text files through vault.read', async () => {
            const vault = new Vault();
            const file = createFile('note.md');
            const readSpy = jest.spyOn(vault, 'read').mockResolvedValue('hello world');
            const binarySpy = jest.spyOn(vault, 'readBinary');

            await expect(readVaultFile(vault, file)).resolves.toBe('hello world');

            expect(readSpy).toHaveBeenCalledWith(file);
            expect(binarySpy).not.toHaveBeenCalled();
        });

        it('reads binary files through vault.readBinary', async () => {
            const vault = new Vault();
            const file = createFile('image.png');
            const bytes = new Uint8Array([1, 2, 3, 4]);
            const readSpy = jest.spyOn(vault, 'read');
            const binarySpy = jest.spyOn(vault, 'readBinary').mockResolvedValue(bytes.buffer);

            const result = await readVaultFile(vault, file);

            expect(result).toBeInstanceOf(Uint8Array);
            expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3, 4]);
            expect(readSpy).not.toHaveBeenCalled();
            expect(binarySpy).toHaveBeenCalledWith(file);
        });
    });

    describe('toArrayBuffer', () => {
        it('returns a matching ArrayBuffer', () => {
            const content = new Uint8Array([10, 20, 30]);

            const buffer = toArrayBuffer(content);

            expect(buffer).toBeInstanceOf(ArrayBuffer);
            expect(Array.from(new Uint8Array(buffer))).toEqual([10, 20, 30]);
        });
    });
});
