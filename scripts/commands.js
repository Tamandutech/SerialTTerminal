// Imports
import {
  PROTOCOL_FIELD_TYPES,
  PROTOCOL_MAX_COMMAND_PAYLOAD,
  MAX_COMMANDS,
  MAX_FIELD_NAME_LEN,
  CMD_ID_MIN,
  CMD_ID_MAX,
  FORMAT_NAME,
  FORMAT_VERSION,
  RESERVED
} from "./definitions.js";
import { protocol_type_size } from "./protocol.js";

let commands = [];

function normalize (raw, error) {
  if (raw === null || typeof raw !== "object") {
    error.message = "The commmand must be an object";
    return null;
  }

  const def = {
    name: (typeof raw.name === "string") ? raw.name.trim () : "",
    id: commands_parse_id (raw.id),
    fields: [],
  };

  const raw_fields = (raw.fields === undefined) ? [] : raw.fields;
  if (!Array.isArray (raw_fields)) {
    error.message = "fields must be a list";
    return null;
  }

  for (let i = 0; i < raw_fields.length; i++) {
    const field = raw_fields[i];
    if (field === null || typeof field !== "object") {
      error.message = "field " + (i + 1) + ": must be an object";
      return null;
    }

    const type = String (field.type);

    def.fields.push({
      name: (typeof field.name === "string") ? field.name.trim() : "",
      type: type,
    });
  }

  return def;
}

function list_has_name (list, name) {
  const lower = name.toLowerCase ();

  for (let i = 0; i < RESERVED.length; i++)
    if (RESERVED[i].name === lower)
      return true;

  for (let i = 0; i < list.length; i++)
    if (list[i].name.toLowerCase() === lower)
      return true;

  return false;
}

function list_has_id (list, id) {
  for (let i = 0; i < RESERVED.length; i++) 
    if (RESERVED[i].id === id)
      return true;
  
  for (let i = 0; i < list.length; i++) 
    if (list[i].id === id)
      return true;
  
  return false;
}

/*
* Checks the incoming list against the previous one
*/
function check_command (command, list, error) {
  // Name
  if (list_has_name (list, command.name)) {
    error.message = "Name \"" + command.name + "\" already in use or reserved";
    return false;
  }
  
  // ID
  if (!Number.isInteger (command.id) || command.id < CMD_ID_MIN || command.id > CMD_ID_MAX) {
    error.message = "Id: set an id from " + commands_format_id (CMD_ID_MIN) + " to " +
    commands_format_id (CMD_ID_MAX);
    return false;
  }
  if (list_has_id (list, command.id)) {
    error.message = "Id " + commands_format_id (command.id) + " already in use";
    return false;
  }
  
  // Fields + payload
  let payload = 0;
  for (let i = 0; i < command.fields.length; i++) {
    const field = command.fields[i];
    if (field.name.length === 0 || field.name.length > MAX_FIELD_NAME_LEN) {
      error.message = "Field " + (i + 1) + ": name with 1 to " + MAX_FIELD_NAME_LEN + " characters";
      return false;
    }
    if (PROTOCOL_FIELD_TYPES.indexOf (field.type) < 0) {
      error.message = "Field \"" + field.name + "\": type \"" + field.type + "\" unknown (" + PROTOCOL_FIELD_TYPES.join (", ") + ")";
      return false;
    }
    payload += protocol_type_size (field.type);
  }
  if (payload > PROTOCOL_MAX_COMMAND_PAYLOAD) {
    error.message = "The fields sum " + payload + " bytes; the maximum is " + PROTOCOL_MAX_COMMAND_PAYLOAD;
    return false;
  }
  
  return true;
}

// Example 32 -> "0x20"
export function commands_format_id (id) {
  const s = id.toString (16).toUpperCase ();
  return ("0x" + ((s.length < 2) ? "0" + s : s));
}

/*
 * "0x20" (as hex) or "32" (as text) or 32 (as integer) -> number
 *  NaN if not an integer
 */
export function commands_parse_id (value) {
  const s = String (value).trim ();

  // Integer
  if (typeof value === "number")
    return (Number.isInteger (value) ? value : NaN);

  // Hex
  if (/^0x[0-9a-f]+$/i.test (s))
    return parseInt (s, 16);

  // Text
  if (/^[0-9]+$/.test (s))
    return parseInt (s, 10);

  return NaN;
}

export function commands_add (raw, error) {
  if (commands.length >= MAX_COMMANDS) {
    error.message = "At most " + MAX_COMMANDS + " commands";
    return false;
  }

  const command = normalize (raw, error);
  if (command === null)
    return false;

  if (!check_command (command, commands, error))
    return false;

  commands.push (command);

  return true;
}

export function commands_to_json () {
  const out = { format: FORMAT_NAME, version: FORMAT_VERSION, commands: [] };

  for (let i = 0; i < commands.length; i++) {
    const command = commands[i];

    const fields = [];
    for (let j = 0; j < command.fields.length; j++) {
      fields.push ({ name: command.fields[j].name, type: command.fields[j].type });
    }
    out.commands.push ({ name: command.name, id: commands_format_id (command.id), fields: fields });
  }

  return JSON.stringify (out, null, 2);
}

export function commands_count () {
  return commands.length;
}

export function commands_get (i) {
  return commands[i];
}

export function commands_from_json (text, error) {
  let data;

  try {
    data = JSON.parse (text);
  } catch (e) {
    error.message = "Invalid JSON: " + e.message;
    return false;
  }

  let raw_list;
  if (Array.isArray (data)) {
    raw_list = data;
  } else if (data !== null && typeof data === "object") {
    if (data.format !== undefined && data.format !== FORMAT_NAME) {
      error.message = "File of other type (format = \"" + data.format + "\")";
      return false;
    }
    if (data.version !== undefined && data.version > FORMAT_VERSION) {
      error.message = "Version " + data.version + " not supported (this page accepts up to version" + FORMAT_VERSION + ")";
      return false;
    }
    raw_list = data.commands;
  }
  if (!Array.isArray (raw_list)) {
    error.message = "The file does not have the list \"commands\"";
    return false;
  }
  if (raw_list.length > MAX_COMMANDS) {
    error.message = "By the most " + MAX_COMMANDS + " commands";
    return false;
  }

  const list = [];
  for (let i = 0; i < raw_list.length; i++) {
    const error2 = { message: "" };
    const command = normalize (raw_list[i], error2);
    if (command === null || !check_command (command, list, error2)) {
      error.message = "Command " + (i + 1) + ": " + error2.message;
      return false;
    }
    list.push (command);
  }

  commands = list;
  return true;
}

export function commands_name_of (id) {
  for (let i = 0; i < commands.length; i++)
    if (commands[i].id === id) return commands[i].name;
  
  return null;
}

export function commands_remove (i) {
  if (!Number.isInteger (i) || i < 0 || i >= commands.length) return false;
  commands.splice (i, 1);
  return true;
}

export function commands_clear () {
  commands = [];
}
