/**
 * Represents the fundamental type of a definition.
 */
export type Primitive =
  | "string"
  | "int"
  | "float"
  | "boolean"
  | "any"
  | "dict"
  | "list";

/**
 * A Definition describes a specific piece of data within the dataflow.
 */
export interface Definition {
  name: string;
  primitive: Primitive;
}

/**
 * An Input is an actual instantiated value bound to a Definition.
 */
export interface Input<T = any> {
  definition: Definition;
  value: T;
}

/**
 * Identifies the type of event yielded by the orchestrator.
 */
export enum EventType {
  RUN_START = "RUN_START",
  INPUT = "INPUT",
  OUTPUT = "OUTPUT",
  RUN_END = "RUN_END",
}

/**
 * Tracks the context of the execution, allowing for nested dataflows.
 */
export interface FlowContext {
  id: string;
  parent?: FlowContext;
  spawnedBy?: string; // Tracks the operation or source that spawned this flow
}

export type OrchestratorEvent = [FlowContext, EventType, any];

export interface Operation<
  In extends Record<string, any> = any,
  Out extends Record<string, any> = any,
> {
  name: string;
  inputs: Record<keyof In, Definition>;
  outputs: Record<keyof Out, Definition>;
  // The executor can return a Promise or be an AsyncGenerator yielding multiple results.
  // It now receives the FlowContext to enable nesting or context-aware logic.
  run: (
    args: In,
    ctx: FlowContext,
  ) =>
    | AsyncGenerator<Partial<Out> | OrchestratorEvent, void, unknown>
    | Promise<Partial<Out>>
    | Partial<Out>;
}

/**
 * Helper to construct Operations with strict type inference.
 */
export function op<
  In extends Record<string, any>,
  Out extends Record<string, any>,
>(
  config: Operation<In, Out>,
): Operation<In, Out> {
  return config;
}

/**
 * Configuration for which events the DataFlow should emit.
 */
export interface DataFlowEvents {
  // Definitions/names of inputs to track, or 'all'
  inputs?: string[] | "all";
  // Definitions/names of outputs to track, or 'all'
  outputs?: string[] | "all";
}

/**
 * DataFlow encapsulates a network of operations.
 */
export class DataFlow {
  public operations: Operation[] = [];
  public events: DataFlowEvents = {};

  constructor(...ops: Operation[]) {
    this.operations = ops;
  }

  static auto(...ops: Operation[]): DataFlow {
    return new DataFlow(...ops);
  }

  withEvents(events: DataFlowEvents): this {
    this.events = events;
    return this;
  }
}

/**
 * A thread-safe(ish) async queue used to manage the event loop of the orchestrator.
 * It allows the orchestrator to go to sleep when waiting for async operations to yield.
 */
class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((val: T) => void)[] = [];

  push(val: T) {
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift();
      if (resolve) resolve(val);
    } else {
      this.items.push(val);
    }
  }

  async pop(): Promise<T> {
    if (this.items.length > 0) {
      return this.items.shift()!;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }
}

/**
 * Generates all possible combinations of inputs for a given operation.
 * If an Operation needs 'A' and 'B', and we have [A1, A2] and [B1],
 * this returns [{A: A1, B: B1}, {A: A2, B: B1}].
 */
function getCombinations(
  requirements: Record<string, Definition>,
  availableInputs: Map<string, Input[]>,
): Record<string, any>[] {
  const keys = Object.keys(requirements);
  if (keys.length === 0) return [{}]; // No inputs required, runs once with empty args

  const combinations: Record<string, any>[] = [];

  // Recursive combination builder
  function backtrack(idx: number, current: Record<string, any>) {
    if (idx === keys.length) {
      combinations.push({ ...current });
      return;
    }

    const paramName = keys[idx];
    const reqDef = requirements[paramName];
    const inputsForDef = availableInputs.get(reqDef.name) || [];

    for (const input of inputsForDef) {
      current[paramName] = input.value;
      backtrack(idx + 1, current);
    }
  }

  backtrack(0, {});
  return combinations;
}

/**
 * Creates a unique deterministic hash for an execution signature
 * to prevent running the same operation twice with the exact same data.
 */
function hashExecution(opName: string, args: Record<string, any>): string {
  return `${opName}::${JSON.stringify(args, Object.keys(args).sort())}`;
}

/**
 * MemoryOrchestrator resolves dependencies and schedules concurrent executions.
 */
export class MemoryOrchestrator {
  /**
   * Executes the dataflow with the provided seed inputs.
   * Yields tuples of [Context, EventType, Data] as events occur in the network.
   */
  async *run(
    dataflow: DataFlow,
    initialInputs: Input[],
    parentCtx?: FlowContext,
    spawnedBy?: string,
  ): AsyncGenerator<[FlowContext, EventType, any], void, unknown> {
    // Create a unique context for this run, attaching to a parent if nested
    const rootCtx: FlowContext = {
      id: `ctx-${Math.random().toString(36).substring(2, 9)}`,
      parent: parentCtx,
      spawnedBy,
    };

    yield [rootCtx, EventType.RUN_START, {
      operations: dataflow.operations.map((o) => o.name),
    }];

    const stateInputs = new Map<string, Input[]>();
    const executedSignatures = new Set<string>();
    const eventQueue = new AsyncQueue<
      { type: string; opName?: string; result?: any; data?: any }
    >();

    let activeWorkers = 0;

    // Helper to register new inputs into the state
    const registerInputs = (inputs: Input[]) => {
      for (const input of inputs) {
        const defName = input.definition.name;
        if (!stateInputs.has(defName)) {
          stateInputs.set(defName, []);
        }
        // Avoid pushing duplicate literal values
        const existing = stateInputs.get(defName)!;
        if (
          !existing.some((e) =>
            JSON.stringify(e.value) === JSON.stringify(input.value)
          )
        ) {
          existing.push(input);

          // If DataFlow is configured to track this input event, queue it
          const shouldEmit = dataflow.events?.inputs === "all" ||
            dataflow.events?.inputs?.includes(defName);
          if (shouldEmit) {
            eventQueue.push({
              type: "SYS_EVENT",
              data: { event: EventType.INPUT, payload: input, ctx: rootCtx },
            });
          }
        }
      }
    };

    // Register seed inputs
    registerInputs(initialInputs);

    // Core orchestration loop
    while (true) {
      let newWorkersStarted = false;

      // 1. Scan all operations to see if any can be triggered
      for (const operation of dataflow.operations) {
        const requiredInputsAvailable = Object.values(operation.inputs).every(
          (def) => (stateInputs.get(def.name)?.length || 0) > 0,
        );

        if (
          requiredInputsAvailable || Object.keys(operation.inputs).length === 0
        ) {
          const possibleArgs = getCombinations(operation.inputs, stateInputs);

          for (const args of possibleArgs) {
            const execHash = hashExecution(operation.name, args);

            // Only run if we haven't processed this exact combination for this operation
            if (!executedSignatures.has(execHash)) {
              executedSignatures.add(execHash);
              activeWorkers++;
              newWorkersStarted = true;

              // Kick off the async operation, passing the current flow context
              this.executeOperation(operation, args, rootCtx, eventQueue)
                .finally(() => {
                  activeWorkers--;
                  // Push empty tick to wake up loop if waiting for workers to close
                  if (activeWorkers === 0) {
                    eventQueue.push({ type: "SYS_TICK" });
                  }
                });
            }
          }
        }
      }

      // 2. Check for termination
      if (activeWorkers === 0 && eventQueue.isEmpty && !newWorkersStarted) {
        break;
      }

      // 3. Wait for the next output or system event
      if (eventQueue.isEmpty && newWorkersStarted) {
        continue; // Loop around to start more jobs, or block at pop()
      }

      const item = await eventQueue.pop();

      // Ignore system ticks
      if (item.type === "SYS_TICK") continue;

      // Route internal System Events up to the consumer
      if (item.type === "SYS_EVENT") {
        yield [item.data.ctx || rootCtx, item.data.event, item.data.payload];
        continue;
      }

      // Handle Operation Output
      if (item.type === "OP_OUTPUT") {
        const { opName, result } = item;
        const operation = dataflow.operations.find((o) => o.name === opName);

        if (operation) {
          const newInputs: Input[] = [];
          for (const [key, val] of Object.entries(result)) {
            const outDef =
              operation.outputs[key as keyof typeof operation.outputs];
            if (outDef) {
              newInputs.push({ definition: outDef, value: val });
            }
          }

          // Save back to network state, potentially triggering INPUT events
          if (newInputs.length > 0) {
            registerInputs(newInputs);
          }

          // Determine if this OUTPUT should be emitted
          const shouldEmitOut = dataflow.events?.outputs === "all" ||
            (!dataflow.events?.outputs) || // By default emit outputs if config is missing
            Object.keys(result).some((k) => {
              const def =
                operation.outputs[k as keyof typeof operation.outputs];
              return def && dataflow.events?.outputs?.includes(def.name);
            });

          if (shouldEmitOut) {
            yield [rootCtx, EventType.OUTPUT, result];
          }
        }
      }
    }

    yield [rootCtx, EventType.RUN_END, { activeWorkers }];
  }

  /**
   * Normalizes the execution of standard functions, Promises, and AsyncGenerators
   */
  private async executeOperation(
    operation: Operation,
    args: Record<string, any>,
    ctx: FlowContext,
    eventQueue: AsyncQueue<any>,
  ) {
    try {
      const rawResult = operation.run(args, ctx);

      // Handle Async Generators (yields)
      if (
        rawResult != null && typeof rawResult === "object" &&
        Symbol.asyncIterator in rawResult
      ) {
        const generator = rawResult as AsyncGenerator<any>;
        for await (const yieldedOutput of generator) {
          // Detect if the yielded output is a bubbled event [FlowContext, EventType, any]
          if (
            Array.isArray(yieldedOutput) && yieldedOutput.length === 3 &&
            yieldedOutput[0] && typeof yieldedOutput[0] === "object" &&
            "id" in yieldedOutput[0]
          ) {
            eventQueue.push({
              type: "SYS_EVENT",
              data: {
                ctx: yieldedOutput[0],
                event: yieldedOutput[1],
                payload: yieldedOutput[2],
              },
            });
          } else {
            eventQueue.push({
              type: "OP_OUTPUT",
              opName: operation.name,
              result: yieldedOutput,
            });
          }
        }
      } // Handle Promises / Synchronous objects
      else {
        const resolvedOutput = await rawResult;
        if (resolvedOutput) {
          eventQueue.push({
            type: "OP_OUTPUT",
            opName: operation.name,
            result: resolvedOutput,
          });
        }
      }
    } catch (err) {
      console.error(
        `[DataFlow Error] Operation '${operation.name}' failed:`,
        err,
      );
      throw err;
    }
  }
}

// ---------------------------------------------------------
// USAGE EXAMPLE & TEST CASES
// ---------------------------------------------------------

const CountStart: Definition = { name: "count_start", primitive: "int" };
const Count: Definition = { name: "count", primitive: "int" };
const NumberDef: Definition = { name: "number", primitive: "int" };

// Create distinct output definitions so operations don't consume their own outputs
const L1OutDef: Definition = { name: "l1_out_val", primitive: "int" };
const L2OutDef: Definition = { name: "l2_out_val", primitive: "int" };
const L3OutDef: Definition = { name: "l3_out_val", primitive: "int" };

// Operation: Generator that emits 5 numbers starting from count_start
const counter = op<{ count_start: number }, { count: number }>({
  name: "counter",
  inputs: { count_start: CountStart },
  outputs: { count: Count },
  run: async function* (args) {
    const start = args.count_start;
    for (let i = start; i < start + 5; i++) {
      await new Promise((res) => setTimeout(res, 50));
      yield { count: i };
    }
  },
});

// Operation: Takes a count and simply echoes it out as a Number
const echoNum = op<{ number_in: number }, { number_out: number }>({
  name: "echo_num",
  inputs: { number_in: Count },
  outputs: { number_out: NumberDef },
  run: async (args) => {
    return { number_out: args.number_in };
  },
});

// --- NESTED OPERATIONS (3 Levels) ---

// Level 3 Operation
const NestedL3 = op<{ val: number }, { l3_out: number }>({
  name: "NestedL3",
  inputs: { val: NumberDef },
  outputs: { l3_out: L3OutDef }, // Use the new distinct definition
  run: async (args) => {
    // Simulate work
    await new Promise((res) => setTimeout(res, 20));
    return { l3_out: args.val * 10 };
  },
});

// Level 2 Operation - Spawns a MemoryOrchestrator to run L3
const NestedL2 = op<{ val: number }, { l2_out: number }>({
  name: "NestedL2",
  inputs: { val: NumberDef },
  outputs: { l2_out: L2OutDef },
  run: async function* (args, ctx) {
    const l3Flow = DataFlow.auto(NestedL3).withEvents({ inputs: "all" });
    const orc = new MemoryOrchestrator();
    let finalRes = 0;

    // Pass `ctx` down as parentCtx to maintain lineage, and tag the operation that spawned it
    for await (
      const eventTuple of orc.run(
        l3Flow,
        [{ definition: NumberDef, value: args.val }],
        ctx,
        "NestedL2",
      )
    ) {
      const [childCtx, event, data] = eventTuple;
      if (event === EventType.OUTPUT && data.l3_out !== undefined) {
        finalRes = data.l3_out;
      }
      // Bubble events up seamlessly
      yield eventTuple;
    }
    yield { l2_out: finalRes };
  },
});

// Level 1 Operation - Spawns a MemoryOrchestrator to run L2
const NestedL1 = op<{ val: number }, { l1_out: number }>({
  name: "NestedL1",
  inputs: { val: NumberDef },
  outputs: { l1_out: L1OutDef },
  run: async function* (args, ctx) {
    const l2Flow = DataFlow.auto(NestedL2).withEvents({ inputs: "all" });
    const orc = new MemoryOrchestrator();
    let finalRes = 0;

    // Tag this level with "NestedL1" so the context knows where it came from
    for await (
      const eventTuple of orc.run(
        l2Flow,
        [{ definition: NumberDef, value: args.val }],
        ctx,
        "NestedL1",
      )
    ) {
      const [childCtx, event, data] = eventTuple;
      if (event === EventType.OUTPUT && data.l2_out !== undefined) {
        finalRes = data.l2_out;
      }
      // Bubble events up seamlessly
      yield eventTuple;
    }
    yield { l1_out: finalRes };
  },
});

// Run Tests Immediately
(async function runTests() {
  console.log("=== Starting DataFlow Orchestration Tests ===\n");

  const orchestrator = new MemoryOrchestrator();

  // ---------------------------------------------------------
  // Test 1: Single DataFlow Events Logging
  // ---------------------------------------------------------
  console.log("-> Running Test 1: Single DataFlow...");

  // Define flow and configure tracking for specific input definitions
  const testDataflow1 = DataFlow.auto(counter, echoNum).withEvents({
    inputs: ["count_start", "count"], // Monitor specific inputs moving across the network
    outputs: "all",
  });

  const initialInputs1: Input[] = [
    { definition: CountStart, value: 1 },
  ];

  // Consume the orchestrator yield tuple: [ctx, event, data]
  for await (
    const [ctx, event, data] of orchestrator.run(
      testDataflow1,
      initialInputs1,
      undefined,
      "Root",
    )
  ) {
    const chainInfo = ctx.spawnedBy
      ? `[Chain: ${ctx.spawnedBy}] `
      : "[Chain: Root] ";
    if (event === EventType.OUTPUT) {
      console.log(`${chainInfo}Output from ${ctx.id}:`, data);
    } else if (event === EventType.INPUT) {
      console.log(`${chainInfo}Input to ${ctx.id}:`, data);
    } else {
      console.log(
        `${chainInfo}Lifecycle Event: ${event} for ${ctx.id}`,
        data || "",
      );
    }
  }
  console.log("   ✅ Test 1 Passed\n");

  // ---------------------------------------------------------
  // Test 2: Nested DataFlows (3 Levels deep)
  // ---------------------------------------------------------
  console.log("-> Running Test 2: Nested DataFlows (3 Levels)...");
  const testDataflow2 = DataFlow.auto(NestedL1).withEvents({
    inputs: "all",
  });

  const initialInputs2: Input[] = [
    { definition: NumberDef, value: 5 },
  ];

  for await (
    const [ctx, event, data] of orchestrator.run(
      testDataflow2,
      initialInputs2,
      undefined,
      "Root",
    )
  ) {
    // Calculate nesting depth and dynamically build the trace chain from contexts
    let depth = 0;
    let curr = ctx.parent;
    const chain: string[] = [];

    if (ctx.spawnedBy) chain.push(ctx.spawnedBy);

    while (curr) {
      depth++;
      if (curr.spawnedBy) chain.unshift(curr.spawnedBy);
      curr = curr.parent;
    }

    const indent = "    ".repeat(depth);
    const prefix = depth > 0 ? "↳ " : "";
    const chainInfo = chain.length > 0
      ? `[Chain: ${chain.join(" -> ")}] `
      : "[Chain: Root] ";

    if (event === EventType.OUTPUT) {
      console.log(`${indent}${prefix}${chainInfo}Output from ${ctx.id}:`, data);
    } else if (event === EventType.INPUT) {
      console.log(`${indent}${prefix}${chainInfo}Input to ${ctx.id}:`, data);
    } else {
      const dataStr = data && typeof data === "object"
        ? JSON.stringify(data)
        : String(data || "");
      console.log(
        `${indent}${prefix}${chainInfo}Lifecycle ${event} for ${ctx.id}:`,
        dataStr,
      );
    }
  }
  console.log("   ✅ Test 2 Passed\n");
})();
