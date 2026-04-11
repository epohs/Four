# Four

A minimal, real-time, two-player 4-in-a-row implementation using a client-first architecture. The system is designed to keep all game state in the browser while using a lightweight WebSocket relay for synchronization between players.

—

# Core Concept

- Each game is identified by a unique token in the URL.
- Two players join the same game via that token.
- All game logic and state live in the browser.
- The backend does not store any game data.
- The backend only relays messages between connected clients.

—

# Stack

## Frontend
- HTML
- CSS (Grid or Flexbox for board layout)
- Vanilla JavaScript

## Backend
- Python
- FastAPI (WebSocket endpoint only)
- Uvicorn (ASGI server)

## Communication
- Native WebSockets (ws:// or wss://)

## Storage
- localStorage (primary)
- IndexedDB (optional for extended history)

—

# Architecture Overview

## Client Responsibilities

- Generate or read game token from URL
- Establish WebSocket connection
- Maintain full game state:
  - Board
  - Move history
  - Turn tracking
  - Score
- Validate moves
- Detect wins/draws
- Persist state locally
- Send and receive messages

## Server Responsibilities

- Accept WebSocket connections
- Group clients by game token (room)
- Relay messages between clients
- Maintain no persistent state

—

# URL Token System

Each game is identified via URL hash:

#game=<uuid>

## Behavior

- If no token exists:
  - Generate one via crypto.randomUUID()
  - Update URL
- If token exists:
  - Join that game

—

# WebSocket Endpoint

/ws/{game_id}

## Connection Flow

1. Client connects to /ws/{game_id}
2. Server registers connection in rooms[game_id]
3. Client begins sending/receiving messages

—

# Message Protocol

All communication is JSON-based.

## Move Event

{
  “type”: “move”,
  “col”: <number>,
  “player”: <string>,
  “move”: <number>
}

## State Request

{
  “type”: “state_request”
}

## State Dump

{
  “type”: “state_dump”,
  “moves”: [...]
}

## Reset Game

{
  “type”: “reset”
}

—

# State Model (Client-Side)

state = {
  moves: [],
  board: [...],
  score: {
    red: 0,
    yellow: 0
  }
}

## Principles

- State is derived from moves
- Board is rebuilt or incrementally updated
- Score persists across matches
- No server authority exists

—

# Game Logic

## Turn Handling

currentPlayer = moves.length % 2

## Move Validation

- Column not full
- Game not already won
- Correct player turn

## Win Detection

- Horizontal
- Vertical
- Diagonal (both directions)

—

# Synchronization Strategy

## Primary Model

Event-based synchronization:
- Only moves are transmitted
- Each client reconstructs state independently

## Advantages

- Minimal bandwidth
- Deterministic state
- Simple conflict model

—

# Reconnection Strategy

On reconnect:

1. Client sends:
{ “type”: “state_request” }

2. Peer responds:
{ “type”: “state_dump”, “moves”: [...] }

3. Client rebuilds state from moves

—

# Persistence

## localStorage

Store:
- moves
- score
- game_id

## Notes

- Data is per browser/device
- Clearing storage resets game
- No cross-device persistence

—

# Backend Implementation Notes

## FastAPI WebSocket Server

- Maintain:
rooms: dict[str, list[WebSocket]]

- On connect:
  - Add socket to room

- On message:
  - Broadcast to other clients in room

- On disconnect:
  - Remove socket

## No Database

- No persistence layer
- No session storage
- Stateless aside from active connections

—

# Deployment Requirements

- Run with:
uvicorn main:app

- Use HTTPS in production:
  - Required for wss://
  - Required for mobile Safari reliability

—

# Constraints and Tradeoffs

## No Authoritative State

- Clients must agree on state
- Desync is possible
- Cheating is possible

## No Persistent Multiplayer History

- Game exists only while at least one client retains state
- Both clients leaving can result in loss of state

## Limited Scalability

- Designed for 2 players per room
- No matchmaking or lobby system

## Reconnection Complexity

- Requires explicit state sync logic

—

# Possible Extensions

- Server-side validation (authoritative model)
- Persistent storage (database)
- Spectator mode
- Matchmaking/lobbies
- AI opponent
- Game replay system

—

# Development Notes

- Favor deterministic logic
- Keep server minimal and stateless
- Treat WebSocket messages as events, not state
- Ensure idempotent move handling where possible
- Design UI to tolerate delayed or out-of-order messages

—

# Summary

Client owns logic and state. Server only relays messages. No persistence. No authority. Minimal backend.
