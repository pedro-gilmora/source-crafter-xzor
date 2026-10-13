import { ServiceProvider, Transient } from "@zor/runtime";

class Hidden {}

@ServiceProvider()
@Transient(Hidden)
export class HiddenServices {}
