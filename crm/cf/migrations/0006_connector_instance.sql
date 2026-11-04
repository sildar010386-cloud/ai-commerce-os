-- Connector instance id (random per process start) and the id of the pending relink command.
-- The relink command now stays pending until the connector acknowledges it (state 'relinking' + commandId), and is handed only to
-- the instance that posted the state last: a stale duplicate process can no longer swallow it.
ALTER TABLE connector ADD COLUMN instance TEXT NOT NULL DEFAULT '';
ALTER TABLE connector ADD COLUMN command_id TEXT NOT NULL DEFAULT '';
