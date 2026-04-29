import { describe, expect, it } from 'vitest';
import { ExposeTool, getExposedTools } from '../../src/decorators';

interface ICalcInput {
  value: number;
}

class DecoratedService {
  @ExposeTool({
    name: 'sumValue',
    displayName: 'Sum Value',
    modelDescription: 'Adds one to value',
  })
  public sum(params: ICalcInput): number {
    return params.value + 1;
  }

  @ExposeTool({
    name: 'doubleValue',
    displayName: 'Double Value',
    modelDescription: 'Doubles value',
    icon: '$(zap)',
    canBeReferencedInPrompt: false,
  })
  public double(params: ICalcInput): number {
    return params.value * 2;
  }
}

describe('decorators', () => {
  it('stores decorated methods metadata on class constructor', () => {
    const tools = getExposedTools(DecoratedService);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      name: 'sumValue',
      displayName: 'Sum Value',
      modelDescription: 'Adds one to value',
      methodName: 'sum',
    });
    expect(tools[1]).toMatchObject({
      name: 'doubleValue',
      icon: '$(zap)',
      canBeReferencedInPrompt: false,
      methodName: 'double',
    });
  });

  it('returns empty metadata for non-decorated classes', () => {
    class PlainService {
      public run(): void {
        // no-op
      }
    }

    expect(getExposedTools(PlainService)).toEqual([]);
  });
});
