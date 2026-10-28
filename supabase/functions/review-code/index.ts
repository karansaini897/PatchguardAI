import { handleAnalyzeReviewEdgeRequest } from '../analyze-review/index.ts';

declare const Deno:
  | {
      serve: (handler: (req: Request) => Response | Promise<Response>) => void;
    }
  | undefined;

export { handleAnalyzeReviewEdgeRequest };

if (typeof Deno !== 'undefined' && typeof Deno?.serve === 'function') {
  Deno.serve(handleAnalyzeReviewEdgeRequest);
}
