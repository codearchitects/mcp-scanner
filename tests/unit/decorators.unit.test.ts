import { describe, expect, it } from 'vitest';
import { ExposeTool, getExposedTools, Tool, getTools } from '../../src/decorators';

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

describe('@Tool decorator', () => {
  it('stores decorated methods metadata on class constructor', () => {
    class ProxyService {
      @Tool({
        name: 'proxySum',
        displayName: 'Proxy Sum',
        modelDescription: 'Proxy that sums value',
      })
      public sum(params: ICalcInput): number {
        return params.value + 1;
      }

      @Tool({
        name: 'proxyDouble',
        displayName: 'Proxy Double',
        modelDescription: 'Proxy that doubles value',
        icon: '$(zap)',
        canBeReferencedInPrompt: true,
      })
      public double(params: ICalcInput): number {
        return params.value * 2;
      }
    }

    const tools = getTools(ProxyService);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      name: 'proxySum',
      displayName: 'Proxy Sum',
      modelDescription: 'Proxy that sums value',
      methodName: 'sum',
    });
    expect(tools[1]).toMatchObject({
      name: 'proxyDouble',
      icon: '$(zap)',
      canBeReferencedInPrompt: true,
      methodName: 'double',
    });
  });

  it('returns empty metadata for non-decorated classes', () => {
    class PlainService {
      public run(): void {
        // no-op
      }
    }

    expect(getTools(PlainService)).toEqual([]);
  });
});

describe('the outputSchema option', () => {
  const outputSchema = { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] };

  it('is accepted and kept by @ExposeTool and @Tool', () => {
    class TypedService {
      @ExposeTool({ name: 'typedExposed', displayName: 'Typed', modelDescription: 'Typed', outputSchema })
      public exposed(): void {
        // no-op
      }

      @Tool({ name: 'typedTool', displayName: 'Typed', modelDescription: 'Typed', outputSchema })
      public tool(): void {
        // no-op
      }
    }

    expect(getExposedTools(TypedService)[0].outputSchema).toEqual(outputSchema);
    expect(getTools(TypedService)[0].outputSchema).toEqual(outputSchema);
  });
});

describe('the annotations option', () => {
  it('is accepted and kept by @ExposeTool and @Tool, in the shape of the MCP TypeScript SDK', () => {
    class ReadOnlyService {
      @ExposeTool({ name: 'readExposed', displayName: 'Read', modelDescription: 'Read', annotations: { readOnlyHint: true } })
      public exposed(): void {
        // no-op
      }

      @Tool({
        name: 'writeTool', displayName: 'Write', modelDescription: 'Write',
        annotations: { readOnlyHint: false },
      })
      public tool(): void {
        // no-op
      }
    }

    expect(getExposedTools(ReadOnlyService)[0].annotations).toEqual({ readOnlyHint: true });
    expect(getTools(ReadOnlyService)[0].annotations).toEqual({ readOnlyHint: false });
  });
});
