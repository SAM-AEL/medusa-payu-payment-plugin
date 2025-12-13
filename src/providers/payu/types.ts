/**
 * PayU Payment Provider Types
 * Type definitions for PayU India payment gateway integration
 */

/**
 * PayU Provider Configuration
 */
export interface PayuProviderConfig {
    /** PayU Merchant Key */
    merchantKey: string
    /** PayU Merchant Salt */
    merchantSalt: string
    /** Environment: "test" for sandbox, "production" for live */
    environment: "test" | "production"
    /** Enable auto-capture (default: true) */
    autoCapture?: boolean
}

/**
 * PayU Payment Request Data (sent to PayU)
 */
export interface PayuPaymentRequestData {
    key: string
    txnid: string
    amount: string
    productinfo: string
    firstname: string
    email: string
    phone: string
    surl: string
    furl: string
    hash: string
    udf1?: string
    udf2?: string
    udf3?: string
    udf4?: string
    udf5?: string
    service_provider?: string
}

/**
 * PayU Session Data stored in Medusa
 */
export interface PayuSessionData {
    txnid: string
    amount: string
    productinfo: string
    firstname: string
    email: string
    phone: string
    hash: string
    paymentUrl: string
    status: PayuPaymentStatus
    countryCode?: string
    payuTransactionId?: string
    payuResponse?: Record<string, unknown>
}

/**
 * PayU Payment Status
 */
export type PayuPaymentStatus =
    | "pending"
    | "authorized"
    | "captured"
    | "failed"
    | "refunded"
    | "cancelled"

/**
 * PayU Webhook Payload (received from PayU)
 */
export interface PayuWebhookPayload {
    mihpayid: string
    mode: string
    status: string
    unmappedstatus: string
    key: string
    txnid: string
    amount: string
    addedon: string
    productinfo: string
    firstname: string
    email: string
    phone: string
    udf1?: string
    udf2?: string
    udf3?: string
    udf4?: string
    udf5?: string
    hash: string
    error?: string
    error_Message?: string
    bank_ref_num?: string
    bankcode?: string
}

/**
 * PayU Verify API Response
 */
export interface PayuVerifyResponse {
    status: number
    msg: string
    transaction_details: {
        [txnid: string]: {
            mihpayid: string
            status: string
            amt: string
            txnid: string
            mode: string
            bank_ref_num?: string
            error_code?: string
            error_Message?: string
        }
    }
}

/**
 * PayU Refund Response
 */
export interface PayuRefundResponse {
    status: number
    msg: string
    request_id?: string
    mihpayid?: string
    error_code?: string
}
