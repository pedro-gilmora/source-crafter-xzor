import { Model, Persist, Validate, maxValue, minValue, required } from "@source-crafter/xzor-runtime/model";

// Plain fields: the build turns them into tracked ones.
export class Worker extends Model {
  @Validate(required) name = "";
  @Validate(minValue(0), maxValue(24)) hours = 0;
  @Validate(minValue(0), maxValue(100)) tax = 0;

  @Persist get payment(): number {
    return this.hours * 20 * (1 - this.tax / 100);
  }
}
