import { ServiceProvider, Transient } from "@xzor/runtime";

class Hidden {}

@ServiceProvider()
@Transient(Hidden)
export class HiddenServices {}
