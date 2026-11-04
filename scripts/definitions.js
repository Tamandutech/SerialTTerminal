/******************************************************************************\
                                    PROTOCOL                                    
\******************************************************************************/
export const PROTOCOL_MAX_COMMAND_PAYLOAD   = 15; 
export const PROTOCOL_SOF                   = 0xAA;
export const PROTOCOL_MAX_LENGTH            = 255;
export const PROTOCOL_TIMEOUT_MS            = 500;
export const PROTOCOL_MAX_TEXT              = 512;
export const PROTOCOL_GAIN_SCALE            = 1000;
export const PROTOCOL_COMMAND_STOP          = 0x10;
export const PROTOCOL_COMMAND_LOG           = 0xF0;
export const PROTOCOL_FIELD_TYPES           = [
    "uint8", "int8", "uint16", "int16", "uint32", "int32", "float32"
];

/******************************************************************************\
                                      MAIN                                      
\******************************************************************************/
export const MAX_FORM_FIELDS                = 8;
export const SERVICE_UUID                   = 0xFFE0;
export const WRITE_PREFERRED_UUID           = "0000ffe3-0000-1000-8000-00805f9b34fb";
export const CHUNK_SIZE                     = 20;
export const STORAGE_KEY                    = "robot-web.commands.v1";

/******************************************************************************\
                                    COMMANDS                                    
\******************************************************************************/
export const RESERVED = [
    {name : "Stop",                           id : 0x01},
    {name : "Set Action",                     id : 0x02},
];
export const CMD_ID_MIN                     = 0x01;
export const CMD_ID_MAX                     = 0x6F;
export const MAX_COMMANDS                   = 32;
export const MAX_FIELD_NAME_LEN             = 24;
export const FORMAT_NAME                    = "robot-web-commands";
export const FORMAT_VERSION                 = 1;