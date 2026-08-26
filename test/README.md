# PiAgent request test

This test starts a local OpenAI-compatible gateway and runs PiAgent against it.
It prints:

- every HTTP request body received by the gateway;
- the request headers with credentials redacted;
- PiAgent session events and streamed text;
- the tool-call round trip (first request -> bash -> second request).

Run it from the repository root:

```text
npx tsx test/piagent-request.ts
```

The test uses Pi SDK `0.83.0`, a local gateway, and an in-memory session. It does
not contact SEP or any external model service.

## Flow covered

1. Start a local HTTP server on an ephemeral port.
2. Register an OpenAI-compatible Pi provider pointing at that server.
3. Create a PiAgent session with `SessionManager.inMemory()`.
4. Send the first prompt and print the exact JSON received by the gateway.
5. Return an assistant tool call from the gateway; PiAgent invokes `bash`.
6. Approve and execute the tool, then print the second request JSON.
7. Return a final SSE text response and print PiAgent events.
8. Assert that both model requests were received.
