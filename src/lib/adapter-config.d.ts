// This file extends the AdapterConfig type from "@types/iobroker"
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            mqttPort: number;
            mqttBaseTopic: string;
            mqttUser: string;
            mqttPassword: string;
            restInterval: number;
            restApiKey: string;
            devices: unknown[];
        }
    }
}
export {};
