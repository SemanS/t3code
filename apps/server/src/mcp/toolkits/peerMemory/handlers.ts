import * as Effect from "effect/Effect";
import * as Memory from "../../PeerMemoryMcpService.ts";
import { PeerMemoryToolkit } from "./tools.ts";

export const PeerMemoryHandlersLive = PeerMemoryToolkit.toLayer({
  peer_memory_search: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.search(input))),
  peer_memory_read: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.read(input))),
  peer_memory_changes: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.changes(input))),
  peer_memory_project: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.project(input))),
  peer_memory_remember: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.execute(input, true))),
  peer_memory_command: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.execute(input))),
  peer_memory_receipt: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.receipt(input))),
  peer_memory_context: (input) =>
    Memory.PeerMemoryMcpService.pipe(Effect.flatMap((service) => service.context(input))),
});
