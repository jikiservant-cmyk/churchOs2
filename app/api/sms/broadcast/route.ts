// Backward-compatible endpoint: all broadcast SMS is persisted by the queue
// route and sent by church-najiki-dispatch, never synchronously in this route.
import { POST as enqueueBroadcast } from '../enqueue/route';

export async function POST(request: Request) {
  return enqueueBroadcast(request);
}
