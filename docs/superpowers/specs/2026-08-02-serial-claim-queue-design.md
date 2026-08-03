# Serial Claim Queue Design

## Problem

The batch runner awaits `queueClaim()`, but that function resolves as soon as a tab is created. A loop over two games therefore opens two tabs immediately. Claim completion is handled later by content-script messages and is not connected back to the batch runner.

## Required behavior

- A batch may have only one active claim tab.
- The next game starts only after the current game reaches a terminal result: `claimed`, `owned`, `failed`, or an unexpected tab close.
- A manual-attention state pauses the queue because the current game is not finished.
- Killing the instance cancels the pending queue.
- Queue state survives Manifest V3 service-worker suspension.

## Design

Store a serial queue in extension session storage, with local-storage fallback. A small pure queue model owns transitions between `pending`, `current`, `results`, `running`, `completed`, and `cancelled`. The background worker pumps one item only when the queue is running and has no current item.

Before navigating a newly created blank tab, the worker persists both the active claim task and the queue's current item. Terminal content-script messages close the completed tab, finish the current queue item, and invoke the pump for exactly one next item. Unexpected tab closure records failure and advances the queue. Manual-attention observations leave the current item in place.

## Testing

Pure model tests prove that beginning one item blocks a second start, terminal completion releases the next item, mismatched tab events cannot advance the queue, and cancellation removes pending work. Existing claim state-machine tests remain unchanged.

