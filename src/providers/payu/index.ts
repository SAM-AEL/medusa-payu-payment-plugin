/**
 * PayU Payment Provider Module
 */

import PayuPaymentProviderService, { PAYU_PROVIDER_ID } from "./service"
import { ModuleProvider, Modules } from "@medusajs/framework/utils"

export default ModuleProvider(Modules.PAYMENT, {
    services: [PayuPaymentProviderService],
})

export { PayuPaymentProviderService, PAYU_PROVIDER_ID }
export * from "./types"

