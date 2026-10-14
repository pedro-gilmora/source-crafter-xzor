import { ServiceProvider, Singleton } from "@source-crafter/xzor-runtime";

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

export interface MaybeDisposable {
  dispose?(): void;
}

export class DisposeFactories {
  static maybe(): MaybeDisposable {
    return {};
  }
}

@ServiceProvider()
@Singleton(SyncSymbol)
@Singleton(AsyncSymbol)
@Singleton(Both)
@Singleton(NotCallable)
@Singleton("maybe", DisposeFactories.maybe)
export class DisposeServices {}
