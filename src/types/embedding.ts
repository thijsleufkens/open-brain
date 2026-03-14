export type TaskType = "document" | "query";

export interface EmbeddingProvider {
  embed(text: string, taskType: TaskType): Promise<Float32Array>;
  readonly dimensions: number;
  readonly modelName: string;
}
