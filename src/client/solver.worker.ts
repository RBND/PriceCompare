import { solveBundleOptimization, type SolverInput } from '../shared/solver.js';

export interface SolverWorkerRequest {
  requestId: number;
  input: SolverInput;
}

export interface SolverWorkerResponse {
  requestId: number;
  result: ReturnType<typeof solveBundleOptimization>;
}

self.onmessage = (event: MessageEvent<SolverWorkerRequest>) => {
  const { requestId, input } = event.data;
  const result = solveBundleOptimization(input);
  const response: SolverWorkerResponse = { requestId, result };
  self.postMessage(response);
};
