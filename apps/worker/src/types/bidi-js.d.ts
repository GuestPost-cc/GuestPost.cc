declare module "bidi-js" {
  interface EmbeddingLevels {
    levels: Uint8Array
    paragraphs: Array<{ start: number; end: number; level: number }>
  }

  interface Bidi {
    getEmbeddingLevels(
      text: string,
      explicitDirection?: "ltr" | "rtl",
    ): EmbeddingLevels
    getReorderedIndices(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): number[]
    getMirroredCharactersMap(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Map<number, string>
  }

  export default function bidiFactory(): Bidi
}
