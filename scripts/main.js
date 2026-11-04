// JavaScript: one of the worse invented programming languages

// Imports
import {
  decoder_reset, decoder_feed, protocol_hex, interp_frame,
  protocol_set_cmd_name_lookup, decoder_init, interp_reset, protocol_build_custom,
  protocol_new_frame,
  protocol_seal_frame
} from "./protocol.js";

import {
  commands_count, commands_get, commands_add, commands_to_json,
  commands_parse_id, commands_format_id, commands_from_json, commands_name_of,
  commands_remove, commands_clear
} from "./commands.js";

import {
  MAX_FORM_FIELDS, PROTOCOL_FIELD_TYPES, SERVICE_UUID, WRITE_PREFERRED_UUID, 
  CHUNK_SIZE, STORAGE_KEY,
  RESERVED
} from "./definitions.js";


// Struct for page UI elements
const ui = {
  show_all        : document.getElementById ("show_all"),
  connect         : document.getElementById ("connect"),

  stop            : document.getElementById ("stop"),
  run             : document.getElementById ("run"),
  map             : document.getElementById ("map"),
  calibrate       : document.getElementById ("calibrate"),
  run_test        : document.getElementById ("run_test"),

  clear_terminal  : document.getElementById ("clear_terminal"),
  terminal        : document.getElementById ("terminal"),
  
  new_fields      : document.getElementById ("new_fields"),
  add_field       : document.getElementById ("add_field"),
  remove_field    : document.getElementById ("remove_field"),
  add_command     : document.getElementById ("add_command"),
  new_name        : document.getElementById ("new_name"),
  new_id          : document.getElementById ("new_id"),
  new_error       : document.getElementById ("new_error"),
  custom_list     : document.getElementById ("custom_list"),

  export          : document.getElementById ("export"),
  import          : document.getElementById ("import"),
  file_import     : document.getElementById ("file_import"),
};

// Struct for global variables
let global = {
  device                  : null,
  connecting              : false,

  rx_characteristic       : null,
  tx_characteristic       : null,

  write_queue             : [],
  writing                 : false,

  new_rows                : [],
  custom_inputs           : [],
  custom_send_buttons     : [],

  buttons_need_connection : [ui.stop, ui.run, ui.map, ui.calibrate, ui.run_test]
};

function pad_3 (text) {
  let string = "" + text;

  while (string.length < 3) {
    string = "0" + string;
  }

  return string;
}

function add_line (klass, text) {
  const now = new Date ();
  const timestamp = now.toTimeString().slice(0, 8) + "." + pad_3 (now.getMilliseconds ());
  const line = document.createElement ("div");

  line.className = "line " + klass;
  line.textContent = timestamp + "  " + text;

  ui.terminal.appendChild (line);
}

function make_element (tag, klass, text) {
  const element = document.createElement (tag);
  if (klass) element.className = klass;
  if (text !== undefined) element.textContent = text;
  return element;
}

function set_connected (connected) {
  for (let i = 0; i < global.buttons_need_connection.length; i++) {
    global.buttons_need_connection[i].disabled = !connected;
  }
  for (let i = 0; i < global.custom_send_buttons.length; i++) {
    global.custom_send_buttons[i].disabled = !connected;
  }
  const name = (global.device && global.device.name) ? "\n\n" + global.device.name : "";
  ui.connect.textContent = connected ? "Disconnect" + name : "Connect";
  ui.connect.disabled = false;
}

function pick_characteristics (characteristics) {
  let rx = null;
  let tx = null;

  for (let i = 0; i < characteristics.length; i++) {
    const characteristic = characteristics[i];
    const can_write = characteristic.properties.write || characteristic.properties.writeWithoutResponse;

    if (rx === null && characteristic.properties.notify)
      rx = characteristic;

    if (can_write) {
      if (characteristic.uuid === WRITE_PREFERRED_UUID)
        tx = characteristic;
      else if (tx === null)
        tx = characteristic;
    }
  }

  return { rx: rx, tx: tx };
}

async function write_chunk (chunk) {
  const properties = global.tx_characteristic.properties;

  if (properties.write && global.tx_characteristic.writeValueWithResponse) 
    return global.tx_characteristic.writeValueWithResponse (chunk);
  if (properties.writeWithoutResponse && global.tx_characteristic.writeValueWithoutResponse) 
    return global.tx_characteristic.writeValueWithoutResponse (chunk);
  return global.tx_characteristic.writeValue (chunk);
}

async function pump_write_queue () {
  if (global.writing) return;
  global.writing = true;

  try {
    while (global.write_queue.length > 0 && global.tx_characteristic !== null) {
      const frame = global.write_queue.shift ();

      for (let position = 0; position < frame.length; position += CHUNK_SIZE) {
        await write_chunk (frame.slice (position, position + CHUNK_SIZE));
      }
    }
  } catch (error) {
    add_line ("nack", "Failed to send: " + error.message);
    global.write_queue.length = 0;
  } finally {
    global.writing = false;
  }
}

function app_cleanup () {
  global.rx_characteristic  = null;
  global.tx_characteristic  = null;
  global.write_queue.length = 0;
  set_connected (false);
}

function app_disconnect () {
  if (global.device && global.device.gatt && global.device.gatt.connected)
    global.device.gatt.disconnect();
  else
    app_cleanup ();
}

async function app_connect () {
  if (!navigator.bluetooth) {
    add_line ("nack", "This browser does not have Web Bluetooth. Use Chrome on Android or computer.");
    return;
  }

  if (global.connecting) return;
  
  // Disable button
  ui.connect.disabled = true;
  global.connecting = true;
  add_line ("sys", "Searching...");

  try {
    let options;

    // Set options
    if (ui.show_all.checked) {
      // Allow all devices
      options = { acceptAllDevices: true, optionalServices: [SERVICE_UUID] };
    } else {
      // Filter devices prefixed with "JDY" or "TT_"
      options = {
        filters: [{ namePrefix: "JDY" }, { namePrefix: "TT_" }],
        optionalServices: [SERVICE_UUID],
      };
    } 

    // Open selector
    global.device = await navigator.bluetooth.requestDevice (options);

    // Assign a callback
    global.device.addEventListener ("gattserverdisconnected", on_gatt_disconnected);

    // Check characteristics
    add_line ("sys", "Connecting...");
    const server = await global.device.gatt.connect ();
    const service = await server.getPrimaryService (SERVICE_UUID);
    const characteristics = await service.getCharacteristics ();
    const picked = pick_characteristics (characteristics);

    global.rx_characteristic = picked.rx;
    global.tx_characteristic = picked.tx;
    if (global.rx_characteristic === null || global.tx_characteristic === null)
      throw new Error("Characteristic of read/write not found on service FFE0");

    interp_reset ();
    decoder_reset ();

    global.rx_characteristic.addEventListener ("characteristicvaluechanged", on_notification);
    await global.rx_characteristic.startNotifications ();

    add_line ("sys",
              "Connected to " + (global.device.name || "device") +
              "  (rx " + global.rx_characteristic.uuid.slice (4, 8) + 
              ", tx " + global.rx_characteristic.uuid.slice(4, 8) + ")");

    set_connected (true);
  } catch (error) {
    if (error && error.name === "NotFoundError")
      add_line ("sys", "No device selected");
    else 
      add_line ("nack", "Failed to connect: " + (error && error.message ? error.message : error));

    if (global.device && global.device.gatt && global.device.gatt.connected)
      global.device.gatt.disconnect ();

    app_cleanup ();
  } finally {
    global.connecting = false;
    ui.connect.disabled = false;
  }
}

function app_remove_field_row () {
  if (global.new_rows.length === 0)
    return;

  const row = global.new_rows.pop ();
  ui.new_fields.removeChild (row.div);
}

function app_add_field_row () {
  if (global.new_rows.length >= MAX_FORM_FIELDS)
    return;

  const div = make_element ("div", "grid");

  const name = make_element ("input");
  name.type = "text";
  name.placeholder = "Field";
  name.maxLength = 24;

  const type = make_element ("select");
  for (let i = 0; i < PROTOCOL_FIELD_TYPES.length; i++) {
    const option = make_element ("option", "", PROTOCOL_FIELD_TYPES[i]);
    option.value = PROTOCOL_FIELD_TYPES[i];
    type.appendChild (option);
  }
  type.value = "uint16";

  div.appendChild (name);
  div.appendChild (type);
  ui.new_fields.appendChild (div);
  global.new_rows.push ({ div: div, name: name, type: type });
}

function app_reset_form () {
  ui.new_name.value = "";
  ui.new_id.value = "";
  ui.new_error.textContent = "";

  while (global.new_rows.length > 0)
    app_remove_field_row ();

  app_add_field_row ();
}

function app_save_commands () {
  if (typeof localStorage === "undefined")
    return;

  try {
    localStorage.setItem (STORAGE_KEY, commands_to_json ());
  } catch (error) {
    add_line ("warn", "Failed to save commands on this browser: " + error.message);
  }
}

function app_load_commands () {
  if (typeof localStorage === "undefined") return;

  let text = null;
  try {
    text = localStorage.getItem (STORAGE_KEY);
  } catch (error) {
    return;
  }
  if (text === null) return;

  const error = { message: "" };
  if (!commands_from_json (text, error)) {
    add_line ("warn", "Saved settings was ignored: " + error.message);
    commands_clear ();
  }
}

function app_render_custom () {
  ui.custom_list.textContent = "";
  global.custom_inputs = [];
  global.custom_send_buttons = [];

  if (commands_count () === 0) {
    ui.custom_list.appendChild (make_element ("div", "hint", "No commands yet..."));
    return;
  }

  for (let i = 0; i < commands_count (); i++) {
    const command = commands_get (i);
    const card = make_element ("div", "command_card");

    const head = make_element ("div", "command_head");
    const title = make_element ("span", "", command.name);
    title.appendChild (make_element ("span", "id", commands_format_id (command.id)));
    head.appendChild (title);

    const button_remove = make_element ("button", "", "x");
    button_remove.type = "button";
    button_remove.title = "Remove";
    button_remove.dataset.action = "remove";
    button_remove.dataset.index = String (i);
    head.appendChild (button_remove);
    card.appendChild (head);

    const inputs = [];
    for (let j = 0; j < command.fields.length; j++) {
      const field = command.fields[j];
      const wrap = make_element ("div", "field");
      wrap.appendChild (make_element ("label", "", field.name + " (" + field.type + ")"));

      const input = make_element ("input");
      input.type = "number";
      // TODO check this
      input.step = (field.type === "float32") ? "any" : "1";
      input.value = "0";
      wrap.appendChild (input);

      card.appendChild (wrap);
      inputs.push (input);
    }
    global.custom_inputs.push (inputs);

    const button_send = make_element ("button", "primary", "Send");
    button_send.type = "button";
    button_send.dataset.action = "send";
    button_send.dataset.index = String (i);
    button_send.disabled = (global.tx_characteristic === null);
    global.custom_send_buttons.push (button_send);
    card.appendChild (button_send);

    ui.custom_list.appendChild (card);
  }
}

function app_send (label, frame, urgent) {
  if (global.tx_characteristic === null) {
    add_line ("nack", "Not connected!");
    return;
  }

  add_line ("tx", "→ " + label + "   " + protocol_hex (frame));

  if (urgent) {
    global.write_queue.length = 0;
    global.write_queue.unshift (frame);
  } else {
    global.write_queue.push (frame);
  }

  pump_write_queue ();
}

function app_send_custom (index) {
  const command = commands_get (index);
  if (command === undefined) return;

  const values = [];
  for (let j = 0; j < command.fields.length; j++) {
    values.push (global.custom_inputs[index][j].valueAsNumber);
  }

  const error = { message: "" };
  const frame = protocol_build_custom (command.id, command.fields, values, error);
  if (frame === null) {
    add_line ("nack", command.name + ": " + error.message);
    return;
  }

  app_send (command.name + (values.length > 0 ? " " + values.join (" ") : ""), frame, false);
}

function on_notification (event) {
  const value = event.target.value;
  const bytes = new Uint8Array (value.buffer, value.byteOffset, value.byteLength);

  decoder_feed (bytes, performance.now ());
}

function on_gatt_disconnected () {
  add_line ("sys", "Disconnected.");
  app_cleanup ();
}

async function on_file_selected () {
  const files = ui.file_import.files;

  if (!files || files.length === 0)
    return;

  let text;
  try {
    text = await files[0].text ();
  } catch (error) {
    add_line ("nack", "Failed to read the file: " + error.message);
    return;
  }

  const error = { message: "" };
  if (!commands_from_json (text, error)) {
    add_line ("nack", "Rejected import: " + error.message);
  } else {
    app_save_commands ();
    app_render_custom ();
    add_line ("sys", "Imported " + commands_count() + " command(s)");
  }

  ui.file_import.value = "";
}

function on_decoder_frame (frame) {
  const entries = interp_frame (frame);
  for (let i = 0; i < entries.length; i++) {
    add_line (entries[i].klass, entries[i].text);
  }
}

function on_decoder_text (text) {
  add_line ("text", text);
}

/*
 * This function treats all buttons on custom list
 */
function on_custom_clicked (event) {
  const target = event.target;
  if (!target || !target.dataset || !target.dataset.action) return;

  const i = Number (target.dataset.index);
  if (target.dataset.action === "remove") {
    commands_remove (i);
    app_save_commands ();
    app_render_custom ();
  } else if (target.dataset.action === "send") {
    app_send_custom (i);
  }
}

function on_button_export_clicked () {
  const text = commands_to_json ();
  const blob = new Blob ([text], { type: "application/json" });
  const url = URL.createObjectURL (blob);

  // This is a workaround to export the data offiline/without a server
  const tmp = document.createElement ("a");
  tmp.href = url;
  tmp.download = "robot-commands.json";
  document.body.appendChild (tmp);
  tmp.click ();
  document.body.removeChild (tmp);
  setTimeout (function () { URL.revokeObjectURL (url); }, 1000);

  add_line ("sys", "Settings exported (" + commands_count () + " command[s])");
}

function on_button_import_clicked () {
  ui.file_import.click ();
}

function on_button_add_command_clicked () {
  const fields = [];

  for (let i = 0; i < global.new_rows.length; i++) {
    const row = global.new_rows[i];

    fields.push ({
      name: row.name.value,
      type: row.type.value,
    });
  }

  const raw = {
    name: ui.new_name.value,
    id: commands_parse_id (ui.new_id.value),
    fields: fields
  };

  const error = { message: "" };
  if (!commands_add (raw, error)) {
    ui.new_error.textContent = error.message;
    return;
  }

  app_save_commands ();
  app_render_custom ();
  add_line ("sys", "Command \"" + raw.name.trim () + "\" added");
  app_reset_form ();
}

async function on_button_connect_clicked () {
  if (global.tx_characteristic !== null)
    app_disconnect ();
  else 
    app_connect ();
}

function on_button_clear_terminal_clicked () {
  ui.terminal.textContent = "";
}

function on_button_stop_clicked () {
  const unsealed = protocol_new_frame (RESERVED[0].id, 0);
  const frame = protocol_seal_frame (unsealed);

  app_send ("Stop", frame, true);
}

function on_button_action_clicked (action_id) {
  const values = [action_id];
  const fields = [{
    name : "Action",
    type : "uint8"
  }];
  const error = { message: "" };
  const frame = protocol_build_custom (RESERVED[1].id, fields, values, error);

  if (frame === null) {
    add_line ("nack", "Action: " + error.message);
    return;
  }

  app_send ("Action", frame, false);
}


function main () {
  decoder_init (on_decoder_frame, on_decoder_text);
  protocol_set_cmd_name_lookup (commands_name_of);

  ui.connect.addEventListener ("click", on_button_connect_clicked);
  ui.clear_terminal.addEventListener ("click", on_button_clear_terminal_clicked);
  ui.add_command.addEventListener ("click", on_button_add_command_clicked);
  ui.add_field.addEventListener ("click", app_add_field_row);
  ui.remove_field.addEventListener ("click", app_remove_field_row);
  ui.export.addEventListener ("click", on_button_export_clicked);
  ui.import.addEventListener ("click", on_button_import_clicked);
  ui.file_import.addEventListener ("change", on_file_selected);
  ui.custom_list.addEventListener ("click", on_custom_clicked);

  ui.stop.addEventListener ("click", on_button_stop_clicked);
  ui.run.addEventListener ("click", () => {on_button_action_clicked (2)});
  ui.map.addEventListener ("click", () => {on_button_action_clicked (3)});
  ui.calibrate.addEventListener ("click", () => {on_button_action_clicked (4)});
  ui.run_test.addEventListener ("click", () => {on_button_action_clicked (5)});

  set_connected (false);

  app_load_commands ();
  app_render_custom ();

  // Show at least 1 field for adding a new comand
  app_add_field_row ();
  
  if (!navigator.bluetooth) 
    alert ("This seems to not support Web Bluetooth. Use a Chromium based browser (computer or Android) or check if this feature isn't disabled");

  if ("serviceWorker" in navigator && location.protocol.startsWith ("http")) {
    navigator.serviceWorker.register ("./scripts/service_worker.js").catch (function (error) {
      add_line ("sys", "Service worker not registered: " + error.message);
    });
  }
}

main ();