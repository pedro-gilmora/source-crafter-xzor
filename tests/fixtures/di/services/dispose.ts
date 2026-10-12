import { ServiceProvider, Singleton } from "@zor/runtime";

export class SyncSymbol {
  [Symbol.dispose](): void {}
}

export class AsyncSymbol {
  async [Symbol.asyncDispose](): Promise<void> {}
}

export class Both {
  dispose(): void {}
  async [Symbol.asyncDispose](): Promise<void> {}
}

export class NotCallable {
  dispose = 1;
}

@ServiceProvider()
@Singleton(SyncSymbol)
@Singleton(AsyncSymbol)
@Singleton(Both)
@Singleton(NotCallable)
export class DisposeServices {}
