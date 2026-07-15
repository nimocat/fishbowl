import type { KnowledgeServiceContract } from './contracts.js'

export type Awaitable<T> = T | Promise<T>

export type AwaitableKnowledgeBackend = {
  [K in keyof KnowledgeServiceContract]:
    KnowledgeServiceContract[K] extends (...args: infer A) => infer R
      ? (...args: A) => Awaitable<R>
      : never
}
