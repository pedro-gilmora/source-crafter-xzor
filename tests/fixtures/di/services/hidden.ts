import { ServiceProvider, Transient } from "@source-crafter/xzor-runtime";

class Hidden {}

@ServiceProvider()
@Transient(Hidden)
export class HiddenServices {}
