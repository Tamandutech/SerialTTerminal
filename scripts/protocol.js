import {
  PROTOCOL_MAX_COMMAND_PAYLOAD,
  PROTOCOL_SOF,
  PROTOCOL_MAX_LENGTH,
  PROTOCOL_TIMEOUT_MS,
  PROTOCOL_MAX_TEXT,
  PROTOCOL_GAIN_SCALE,
  PROTOCOL_COMMAND_STOP,
  PROTOCOL_COMMAND_LOG
} from "./definitions.js";

const DECODER = Object.freeze ({
  TEXT    : 0,
  LENGTH  : 1,
  BODY    : 2,
  CRC     : 3,
});

const LEVEL_CLASS = ["error", "warning", "info", "debug"];

let protocol = {
  cmd_name_lookup : null,
}

let interpreter = {
  last_log_sequence : -1
};

let decoder = {
  state : DECODER.TEXT,

  // [LEN][CMD][payload ...]
  buffer : new Uint8Array (PROTOCOL_MAX_LENGTH + 1),

  // Length of current frame
  length : 0,

  // Received bytes
  received : 0,

  last_ms           : 0,
  text              : "",
  on_frame_callback : null,
  on_text_callback  : null,
};

function hex_byte (byte) {
  const s = byte.toString (16).toUpperCase ();
  return (s.length < 2) ? "0" + s : s;
}

// Note: le stands for little-endian
function put_u16_le (buffer, position, value) {
  buffer[position] = value & 0xFF;
  buffer[position + 1] = (value >> 8) & 0xFF;
  return position + 2;
}

// Note: le stands for little-endian
function put_i32_le (buffer, position, value) {
  buffer[position] = value & 0xFF;
  buffer[position + 1] = (value >> 8) & 0xFF;
  buffer[position + 2] = (value >> 16) & 0xFF;
  buffer[position + 3] = (value >> 24) & 0xFF;
  return position + 4;
}

function put_field (frame, position, field, value, error) {
  if (!Number.isFinite (value)) {
    error.message = field.name + ": type a number";
    return -1;
  }

  if (field.type === "float32") {
    const scaled =  Math.round (value * PROTOCOL_GAIN_SCALE);
    return put_i32_le (frame, position, scaled);
  }

  const size = protocol_type_size (field.type);
  if (size === 1) {
    frame[position] = value & 0xFF;
    return position + 1;
  }

  if (size === 2)
    return put_u16_le (frame, position, value);

  // 4 bytes: also works for uint32
  return put_i32_le (frame, position, value);
}


/******************************************************************************\
                                    PROTOCOL                                    
\******************************************************************************/
export function protocol_crc8 (buffer, start, length) {
  let crc = 0;

  for (let i = start; i < start + length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      if (crc & 0x80)
        crc = ((crc << 1) ^ 0x07) & 0xFF;
      else
        crc = (crc << 1) & 0xFF;
    }
  }

  return crc;
}

export function protocol_type_size (type) {
  switch (type) {
    case "uint8":
    case "int8":
      return 1;

    case "uint16":
    case "int16":
      return 2;

    case "uint32":
    case "int32":
    case "float32":
      return 4;

    default:
      return 0;
  }
}

export function protocol_hex (bytes) {
  let out = "";

  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) out += " ";
    out += hex_byte(bytes[i]);
  }

  return out;
}

export function protocol_set_cmd_name_lookup (fn) {
  protocol.cmd_name_lookup = fn;
}

export function protocol_build_custom (command_id, fields, values, error) {
  if (values.length !== fields.length) {
    error.message = "Number of values different from number of fields";
    return null;
  }

  let payload_length = 0;
  for (let i = 0; i < fields.length; i++) {
    payload_length += protocol_type_size (fields[i].type);
  }
  if (payload_length > PROTOCOL_MAX_COMMAND_PAYLOAD) {
    error.message = "Payload of " + payload_length + " bytes; The maximum is " + PROTOCOL_MAX_COMMAND_PAYLOAD;
    return null;
  }

  const frame = protocol_new_frame (command_id, payload_length);
  let position = 3;
  for (let i = 0; i < fields.length; i++) {
    position = put_field (frame, position, fields[i], values[i], error);
    if (position < 0) return null;
  }
  return protocol_seal_frame (frame);
}

function protocol_cmd_name (id) {
  switch (id) {
  case PROTOCOL_COMMAND_STOP: return "stop";
  // ...
  default:
    if (protocol.cmd_name_lookup) {
      const name = protocol.cmd_name_lookup (id);
      if (name) return name;
    }
    return "0x" + hex_byte (id);
  }
}

function protocol_status_text (status) {
  switch (status) {
  case 0: return "Ok";
  case 1: return "Unknown command";
  case 2: return "Incorrect length";
  case 3: return "Invalid value";
  default: return "status " + status;
  }
}

function protocol_level_class (level) {
  return (level < LEVEL_CLASS.length) ? LEVEL_CLASS[level] : "info";
}

/*
 * Buffer layout:  [0]=SOF  [1]=LEN  [2]=CMD  [3...]=payload  [last]=CRC
 * Payload always starts on index 3.
 */
export function protocol_new_frame (command, payload_length) {
  const frame = new Uint8Array  (payload_length + 4);
  frame[0] = PROTOCOL_SOF;
  // LEN = CMD + payload
  frame[1] = payload_length + 1;
  frame[2] = command;
  return frame;
}

// Fills the last byte with the CRC of LEN, CMD and payload
export function protocol_seal_frame (frame) {
  const n = frame.length;
  frame[n - 1] = protocol_crc8 (frame, 1, n - 2);
  return frame;
}


/******************************************************************************\
                                   INTERPRETER                                  
\******************************************************************************/
export function interp_reset () {
  interpreter.last_log_sequence = -1;
}

export function interp_frame (frame) {
  const out = [];
  const command = frame.cmd;
  const payload = frame.payload;

  if (command === PROTOCOL_COMMAND_LOG) {
    if (payload.length < 2) {
      out.push ({ klass: "warn", text: "Bad formatted log: " + protocol_hex (payload) });
      return out;
    }
    const level = payload[0];
    const sequence = payload[1];

    if (interpreter.last_log_sequence >= 0) {
      const lost = (sequence - interpreter.last_log_sequence - 1) & 0xFF;
      if (lost > 0)
         out.push ({ klass: "warn", text: "⚠ " + lost + " lost logs(s)" });
    }
    interpreter.last_log_sequence = sequence;

    const text = new TextDecoder ("utf-8").decode (payload.subarray (2));
    out.push ({
      klass: "log-" + protocol_level_class (level),
      text: "[" + protocol_level_name (level) + "] " + text,
    });
    return out;
  }

  if (command > 0x80 && command < PROTOCOL_COMMAND_LOG) {
    const name = protocol_cmd_name (command & 0x7F);
    if (payload.length !== 1) {
      out.push({ klass: "warn", text: "← " + name + ": bad formed response (" + protocol_hex (payload) + ")" });
      return out;
    }
    const status = payload[0];
    out.push({
      klass: (status === 0) ? "ok" : "nack",
      text: "← " + name + ": " + protocol_status_text (status),
    });
    return out;
  }

  out.push ({
    klass: "warn",
    text: "Unknown frame (cmd 0x" + hex_byte (command) + "): " + protocol_hex (payload),
  });
  return out;
}



/******************************************************************************\
                                     DECODER                                    
\******************************************************************************/
export function decoder_init (on_frame_callback, on_text_callback) {
  decoder.on_frame_callback = on_frame_callback;
  decoder.on_text_callback  = on_text_callback;

  decoder_reset ();
}

export function decoder_reset () {
  decoder.state     = DECODER.TEXT;
  decoder.length    = 0;
  decoder.received  = 0;
  decoder.last_ms   = 0;
  decoder.text      = "";
}

function decoder_flush_text () {
  if (decoder.text.length > 0) {
    if (decoder.on_text_callback)
      decoder.on_text_callback (decoder.text);

    decoder.text = "";
  }
}

function decoder_feed_byte (byte, now_ms) {
  // Check for the frame timeout
  if (decoder.state !== DECODER.TEXT && (now_ms - decoder.last_ms) > PROTOCOL_TIMEOUT_MS) {
    decoder.state = DECODER.TEXT;
  }
  decoder.last_ms = now_ms;

  switch (decoder.state) {
  case DECODER.TEXT:
    if (byte === PROTOCOL_SOF) {
      // Flush previous frames
      decoder_flush_text ();             
      decoder.state = DECODER.LENGTH;
    } else if (byte === 0x0A) {
      // For '\n'
      decoder_flush_text ();
    } else if (byte === 0x0D) {
      // Ignore '\r'
    } else if ((byte >= 0x20 && byte < 0x7F) || byte === 0x09) {
      decoder.text += String.fromCharCode (byte);
      if (decoder.text.length >= PROTOCOL_MAX_TEXT)
        decoder_flush_text ();
    } else {
      // Ignore any other byte
    }
    break;

  case DECODER.LENGTH:
    if (byte >= 1 && byte <= PROTOCOL_MAX_LENGTH) {
      decoder.buffer[0] = byte;
      decoder.length = byte;
      decoder.received = 0;
      decoder.state = DECODER.BODY;
    } else if (byte !== PROTOCOL_SOF) {
      // Invalid length
      decoder.state = DECODER.TEXT;
    }
    break;

  case DECODER.BODY:
    decoder.buffer[1 + decoder.received] = byte;
    decoder.received += 1;
    if (decoder.received === decoder.length)
      decoder.state = DECODER.CRC;
    break;

  case DECODER.CRC:
    decoder.state = DECODER.TEXT;
    if (protocol_crc8 (decoder.buffer, 0, decoder.length + 1) === byte) {
      if (decoder.on_frame_callback) {
        decoder.on_frame_callback ({ cmd: decoder.buffer[1], payload: decoder.buffer.slice(2, decoder.length + 1) });
      }
    } else {
      // Wrong CRC, discard frame
    }
    break;
  }
}

export function decoder_feed (bytes, now_ms) {
  for (let i = 0; i < bytes.length; i++) {
    decoder_feed_byte (bytes[i], now_ms);
  }
}
