/**
 * PayU Payment Provider Service
 * MedusaJS 2 Payment Provider for PayU India
 * 
 * Implements redirect-based payment flow using official payu-websdk
 */

import {
    AbstractPaymentProvider,
    BigNumber,
    MedusaError,
    PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
    InitiatePaymentInput,
    InitiatePaymentOutput,
    AuthorizePaymentInput,
    AuthorizePaymentOutput,
    CapturePaymentInput,
    CapturePaymentOutput,
    RefundPaymentInput,
    RefundPaymentOutput,
    CancelPaymentInput,
    CancelPaymentOutput,
    DeletePaymentInput,
    DeletePaymentOutput,
    GetPaymentStatusInput,
    GetPaymentStatusOutput,
    RetrievePaymentInput,
    RetrievePaymentOutput,
    UpdatePaymentInput,
    UpdatePaymentOutput,
    ProviderWebhookPayload,
    WebhookActionResult,
    Logger,
} from "@medusajs/framework/types"

import type { PayuProviderConfig, PayuSessionData, PayuWebhookPayload, PayuPaymentStatus } from "./types"
import { PayuClient, generateTxnId } from "./client"

export const PAYU_PROVIDER_ID = "payu"

/**
 * PayU Payment Provider Service
 * 
 * Flow:
 * 1. initiatePayment - Returns session data with payment URL and form data
 * 2. Frontend redirects customer to PayU checkout
 * 3. Customer completes payment on PayU
 * 4. PayU redirects back and sends webhook
 * 5. authorizePayment - Verifies and marks payment as authorized
 */
class PayuPaymentProviderService extends AbstractPaymentProvider<PayuProviderConfig> {
    static identifier = PAYU_PROVIDER_ID

    /**
     * Validate provider options at startup
     * Called by MedusaJS when registering the provider
     */
    static validateOptions(options: Record<string, unknown>): void {
        if (!options.merchantKey) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "PayU: merchantKey is required. Set PAYU_MERCHANT_KEY environment variable."
            )
        }
        if (!options.merchantSalt) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "PayU: merchantSalt is required. Set PAYU_MERCHANT_SALT environment variable."
            )
        }
    }

    protected config_: PayuProviderConfig
    protected logger_: Logger
    protected client_: PayuClient

    constructor(container: Record<string, unknown>, config: PayuProviderConfig) {
        super(container, config)

        if (!config.merchantKey || !config.merchantSalt) {
            throw new Error(
                "PayU: merchantKey and merchantSalt are required. " +
                "Set PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT environment variables."
            )
        }

        this.config_ = {
            merchantKey: config.merchantKey,
            merchantSalt: config.merchantSalt,
            environment: config.environment || "test",
            autoCapture: config.autoCapture ?? true,
        }

        this.logger_ = container.logger as Logger
        this.client_ = new PayuClient(this.config_, this.logger_)

        this.logger_?.info?.(`PayU initialized in ${this.config_.environment} mode`)
    }

    /**
     * Format amount to string with 2 decimals (PayU requirement)
     */
    private formatAmount(amount: unknown): string {
        const num = typeof amount === "string" ? parseFloat(amount) : Number(amount)
        return num.toFixed(2)
    }

    /**
     * Initiate payment session
     */
    async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
        const { amount, context } = input

        try {
            const txnid = generateTxnId()
            const formattedAmount = this.formatAmount(amount)

            const customer = context?.customer
            const inputData = input.data as Record<string, unknown> | undefined

            // Fallback chain: customer data -> input data (passed from frontend)
            // MedusaJS may not always populate the full customer context
            const email = customer?.email || (inputData?.email as string)
            if (!email) {
                throw new Error("Customer email is required for payment processing. Pass email in data payload or ensure customer is logged in.")
            }

            const firstname = customer?.first_name || (inputData?.firstname as string) || (inputData?.first_name as string)
            if (!firstname) {
                throw new Error("Customer name is required for payment processing. Pass firstname in data payload.")
            }

            // Fallback chain: customer phone -> billing address phone -> shipping address phone -> input data
            const phone = customer?.phone
                || customer?.billing_address?.phone
                || (inputData?.shipping_address_phone as string)
                || (inputData?.phone as string)
            if (!phone) {
                throw new Error("Phone number is required for payment processing. Pass phone in data payload.")
            }

            const productinfo = (inputData?.productinfo as string) || "Order Payment"

            // Build redirect URLs from environment variables
            const storefrontUrl = process.env.STOREFRONT_URL
            const redirectPath = process.env.PAYU_REDIRECT_URL
            const redirectFailurePath = process.env.PAYU_REDIRECT_FAILURE_URL

            if (!storefrontUrl || !redirectPath || !redirectFailurePath) {
                throw new Error("STOREFRONT_URL, PAYU_REDIRECT_URL, and PAYU_REDIRECT_FAILURE_URL environment variables are required")
            }

            const countryCode = (inputData?.country_code as string) || "in"
            const surl = `${storefrontUrl}/${countryCode}${redirectPath}`
            const furl = `${storefrontUrl}/${countryCode}${redirectFailurePath}`

            // Generate hash using SDK
            const hash = this.client_.generatePaymentHash({
                txnid,
                amount: formattedAmount,
                productinfo,
                firstname,
                email,
            })

            const sessionData: PayuSessionData = {
                txnid,
                amount: formattedAmount,
                productinfo,
                firstname,
                email,
                phone,
                hash,
                paymentUrl: this.client_.getPaymentUrl(),
                status: "pending",
                countryCode,
            }

            this.logger_?.debug?.(`PayU payment initiated: ${txnid}`)

            return {
                id: txnid,
                data: {
                    ...sessionData,
                    form_data: {
                        key: this.config_.merchantKey,
                        txnid,
                        amount: formattedAmount,
                        productinfo,
                        firstname,
                        email,
                        phone,
                        surl,
                        furl,
                        hash,
                        service_provider: "payu_paisa",
                    },
                } as unknown as Record<string, unknown>,
            }
        } catch (error) {
            this.logger_?.error?.(`PayU initiatePayment error: ${error}`)
            throw error
        }
    }

    /**
     * Authorize payment after PayU callback
     */
    async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
        try {
            const sessionData = input.data as unknown as PayuSessionData

            if (sessionData.status === "authorized" || sessionData.status === "captured") {
                return {
                    status: PaymentSessionStatus.AUTHORIZED,
                    data: input.data,
                }
            }

            const response = await this.client_.verifyPayment(sessionData.txnid)

            if (response.status === 1) {
                const txn = response.transaction_details[sessionData.txnid]
                if (txn?.status === "success") {
                    this.logger_?.info?.(`PayU authorized: ${sessionData.txnid}`)
                    return {
                        status: PaymentSessionStatus.AUTHORIZED,
                        data: {
                            ...sessionData,
                            status: "authorized" as PayuPaymentStatus,
                            payuTransactionId: txn.mihpayid,
                            payuResponse: txn,
                        } as unknown as Record<string, unknown>,
                    }
                }
            }

            return {
                status: PaymentSessionStatus.ERROR,
                data: { ...sessionData, status: "failed" as PayuPaymentStatus },
            }
        } catch (error) {
            this.logger_?.error?.(`PayU authorizePayment error: ${error}`)
            throw error
        }
    }

    /**
     * Capture payment (PayU auto-captures)
     */
    async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
        const sessionData = input.data as unknown as PayuSessionData
        return {
            data: { ...sessionData, status: "captured" as PayuPaymentStatus } as unknown as Record<string, unknown>,
        }
    }

    /**
     * Refund payment
     */
    async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
        try {
            const sessionData = input.data as unknown as PayuSessionData

            if (!sessionData.payuTransactionId) {
                throw new Error(
                    "No PayU transaction ID (mihpayid) found. " +
                    "This payment may not have been fully captured or the session data is incomplete."
                )
            }

            const tokenId = `REF_${sessionData.payuTransactionId}_${Date.now()}`
            const refundAmount = this.formatAmount(input.amount)

            this.logger_?.info?.(
                `PayU refund request: mihpayid=${sessionData.payuTransactionId}, ` +
                `txnid=${sessionData.txnid}, amount=${refundAmount}, tokenId=${tokenId}`
            )

            const response = await this.client_.refund(
                sessionData.payuTransactionId,
                tokenId,
                refundAmount
            )

            // Log full PayU response for debugging
            this.logger_?.info?.(
                `PayU refund response: status=${response.status}, msg=${response.msg}, ` +
                `request_id=${response.request_id || 'N/A'}, mihpayid=${response.mihpayid || 'N/A'}, ` +
                `error_code=${response.error_code || 'N/A'}, full=${JSON.stringify(response)}`
            )

            if (response.status === 1) {
                // Check for same-day capture message (treated as pending success)
                if (response.msg?.includes?.("Capture is done today")) {
                    this.logger_?.info?.(
                        `PayU refund queued for ${sessionData.txnid}: Same-day capture, ` +
                        `refund will be processed tomorrow. request_id=${response.request_id}`
                    )
                }

                this.logger_?.info?.(`PayU refund successful: ${sessionData.txnid}, request_id=${response.request_id}`)
                return {
                    data: {
                        ...sessionData,
                        status: "refunded" as PayuPaymentStatus,
                        refund: {
                            tokenId,
                            amount: refundAmount,
                            request_id: response.request_id,
                            response
                        },
                    } as unknown as Record<string, unknown>,
                }
            }

            // Handle specific refund failure scenarios
            let errorMessage = response.msg || "Unknown error"

            // Common PayU refund errors with helpful messages
            if (response.msg?.toLowerCase?.().includes?.("try after some time")) {
                errorMessage =
                    `PayU says: "${response.msg}". ` +
                    `This usually means: ` +
                    `(1) The payment was captured today and PayU requires 24 hours before refund, ` +
                    `(2) A refund is already in progress for this transaction, or ` +
                    `(3) PayU is experiencing temporary issues. Please try again later.`
            } else if (response.msg?.toLowerCase?.().includes?.("token already used")) {
                errorMessage =
                    `Refund token already used. A refund may already be pending for this transaction. ` +
                    `Please check the transaction status in PayU dashboard.`
            } else if (response.msg?.toLowerCase?.().includes?.("transaction not exists")) {
                errorMessage =
                    `Transaction not found in PayU. The mihpayid (${sessionData.payuTransactionId}) may be incorrect.`
            } else if (response.msg?.toLowerCase?.().includes?.("amount")) {
                errorMessage =
                    `Invalid refund amount (${refundAmount}). Please ensure it doesn't exceed the original transaction amount.`
            }

            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                `Refund failed: ${errorMessage}`
            )
        } catch (error) {
            this.logger_?.error?.(`PayU refundPayment error: ${error}`)
            // Re-throw MedusaErrors as-is so message is preserved
            if (error instanceof MedusaError) {
                throw error
            }
            // Wrap unexpected errors with context
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                error instanceof Error ? error.message : String(error)
            )
        }
    }

    /**
     * Cancel payment
     */
    async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
        const sessionData = input.data as unknown as PayuSessionData
        return {
            data: { ...sessionData, status: "cancelled" as PayuPaymentStatus } as unknown as Record<string, unknown>,
        }
    }

    /**
     * Delete payment session
     */
    async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
        return { data: input.data }
    }

    /**
     * Get payment status
     */
    async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
        const sessionData = input.data as unknown as PayuSessionData

        const statusMap: Record<PayuPaymentStatus, PaymentSessionStatus> = {
            pending: PaymentSessionStatus.PENDING,
            authorized: PaymentSessionStatus.AUTHORIZED,
            captured: PaymentSessionStatus.AUTHORIZED,
            failed: PaymentSessionStatus.ERROR,
            refunded: PaymentSessionStatus.AUTHORIZED,
            cancelled: PaymentSessionStatus.CANCELED,
        }

        return { status: statusMap[sessionData.status] || PaymentSessionStatus.PENDING }
    }

    /**
     * Retrieve payment details
     */
    async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
        return { data: input.data }
    }

    /**
     * Update payment session
     */
    async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
        try {
            const { data, amount } = input
            const sessionData = data as unknown as PayuSessionData

            if (amount) {
                const formattedAmount = this.formatAmount(amount)
                const storefrontUrl = process.env.STOREFRONT_URL || ""
                const redirectPath = process.env.PAYU_REDIRECT_URL || ""
                const redirectFailurePath = process.env.PAYU_REDIRECT_FAILURE_URL || ""

                const hash = this.client_.generatePaymentHash({
                    txnid: sessionData.txnid,
                    amount: formattedAmount,
                    productinfo: sessionData.productinfo,
                    firstname: sessionData.firstname,
                    email: sessionData.email,
                })

                const surl = `${storefrontUrl}/${sessionData.countryCode || 'in'}${redirectPath}`
                const furl = `${storefrontUrl}/${sessionData.countryCode || 'in'}${redirectFailurePath}`

                return {
                    data: {
                        ...sessionData,
                        amount: formattedAmount,
                        hash,
                        form_data: {
                            key: this.config_.merchantKey,
                            txnid: sessionData.txnid,
                            amount: formattedAmount,
                            productinfo: sessionData.productinfo,
                            firstname: sessionData.firstname,
                            email: sessionData.email,
                            phone: sessionData.phone,
                            surl,
                            furl,
                            hash,
                            service_provider: "payu_paisa",
                        },
                    } as unknown as Record<string, unknown>,
                }
            }

            return { data: data as Record<string, unknown> }
        } catch (error) {
            this.logger_?.error?.(`PayU updatePayment error: ${error}`)
            throw error
        }
    }

    /**
     * Handle webhook from PayU
     * 
     * PayU sends webhooks for payment status updates.
     * Webhook URL format: https://your-backend.com/hooks/payment/payu_payu
     * 
     * The webhook payload is URL-encoded form data with fields matching PayuWebhookPayload.
     * Hash verification ensures the webhook is authentic and hasn't been tampered with.
     */
    async getWebhookActionAndData(data: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
        try {
            // Enhanced debug logging - log the full payload structure
            this.logger_?.info?.(
                `PayU webhook: RAW PAYLOAD STRUCTURE - ` +
                `data keys: ${data ? Object.keys(data as object).join(', ') : 'null'}, ` +
                `data.data keys: ${data?.data ? Object.keys(data.data as object).join(', ') : 'null'}, ` +
                `Full payload (first 1000 chars): ${JSON.stringify(data)?.substring(0, 1000) || 'undefined'}`
            )

            // PayU webhooks send form-urlencoded data which MedusaJS parses
            // The data location may vary - check both data.data and direct data properties
            // Also handle case where MedusaJS puts parsed body directly in data
            let webhook: PayuWebhookPayload

            // Check for rawData (Buffer/string from raw body) that needs parsing
            if ((data as Record<string, unknown>)?.rawData) {
                const rawData = (data as Record<string, unknown>).rawData
                this.logger_?.debug?.(`PayU webhook: Found rawData, type=${typeof rawData}`)

                // If rawData is a Buffer or string, parse it as URL-encoded form data
                if (typeof rawData === 'string' || Buffer.isBuffer(rawData)) {
                    const bodyStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : rawData
                    const params = new URLSearchParams(bodyStr)
                    webhook = Object.fromEntries(params.entries()) as unknown as PayuWebhookPayload
                    this.logger_?.debug?.(`PayU webhook: Parsed rawData, txnid=${webhook.txnid}`)
                } else {
                    webhook = rawData as unknown as PayuWebhookPayload
                }
            }
            // Check if data.data contains the webhook fields
            else if (data?.data && typeof data.data === 'object') {
                const dataObj = data.data as Record<string, unknown>
                // If data.data has txnid or status, use it directly
                if (dataObj.txnid || dataObj.status) {
                    webhook = data.data as unknown as PayuWebhookPayload
                    this.logger_?.debug?.(`PayU webhook: Using data.data, txnid=${webhook.txnid}`)
                } else {
                    // data.data might be empty or contain nested structure
                    this.logger_?.warn?.(`PayU webhook: data.data has no txnid/status. Keys: ${Object.keys(dataObj).join(', ')}`)
                    webhook = data.data as unknown as PayuWebhookPayload
                }
            }
            // Check if the fields are directly on data (MedusaJS might parse body there)
            else if ((data as Record<string, unknown>)?.txnid || (data as Record<string, unknown>)?.status) {
                webhook = data as unknown as PayuWebhookPayload
                this.logger_?.debug?.(`PayU webhook: Using data directly, txnid=${webhook.txnid}`)
            }
            // No valid data structure found
            else {
                this.logger_?.error?.(
                    `PayU webhook: INVALID PAYLOAD - No data received. ` +
                    `Raw payload: ${JSON.stringify(data)?.substring(0, 500) || 'undefined'}`
                )
                return { action: "not_supported" }
            }

            // Validate required fields exist
            if (!webhook.txnid || !webhook.status || !webhook.hash) {
                this.logger_?.error?.(
                    `PayU webhook: INVALID PAYLOAD - Missing required fields. ` +
                    `txnid=${webhook.txnid ?? 'MISSING'}, status=${webhook.status ?? 'MISSING'}, ` +
                    `hash=${webhook.hash ? 'present' : 'MISSING'}. ` +
                    `This may indicate PayU sent malformed data or the webhook URL received non-PayU traffic. ` +
                    `Available keys in webhook: ${Object.keys(webhook as object).join(', ')}`
                )
                return { action: "not_supported" }
            }

            // Enhanced logging for production debugging and audit trail
            this.logger_?.info?.(
                `PayU webhook received: txnid=${webhook.txnid}, mihpayid=${webhook.mihpayid || 'N/A'}, ` +
                `status=${webhook.status}, amount=${webhook.amount || 'N/A'}, mode=${webhook.mode || 'N/A'}`
            )

            // Verify hash to ensure webhook authenticity
            // Formula: sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
            const isValid = this.client_.verifyResponseHash({
                status: webhook.status,
                email: webhook.email,
                firstname: webhook.firstname,
                productinfo: webhook.productinfo,
                amount: webhook.amount,
                txnid: webhook.txnid,
                hash: webhook.hash,
                udf1: webhook.udf1,
                udf2: webhook.udf2,
                udf3: webhook.udf3,
                udf4: webhook.udf4,
                udf5: webhook.udf5,
            })

            if (!isValid) {
                this.logger_?.warn?.(
                    `PayU webhook: Hash verification FAILED for txnid=${webhook.txnid}. ` +
                    `This could indicate a tampered webhook or configuration mismatch.`
                )
                return { action: "not_supported" }
            }

            this.logger_?.debug?.(`PayU webhook: Hash verified successfully for txnid=${webhook.txnid}`)

            // Session ID matches the transaction ID returned from initiatePayment
            const sessionId = webhook.udf1 || webhook.txnid
            const status = webhook.status.toLowerCase()

            if (status === "success") {
                this.logger_?.info?.(`PayU webhook: Payment SUCCESS for txnid=${webhook.txnid}, authorizing session ${sessionId}`)
                return {
                    action: "authorized",
                    data: {
                        session_id: sessionId,
                        amount: new BigNumber(parseFloat(webhook.amount)),
                    },
                }
            }

            if (status === "failure" || status === "failed") {
                this.logger_?.info?.(
                    `PayU webhook: Payment FAILED for txnid=${webhook.txnid}, ` +
                    `error=${webhook.error || 'N/A'}, error_Message=${webhook.error_Message || 'N/A'}`
                )
                return {
                    action: "failed",
                    data: {
                        session_id: sessionId,
                        amount: new BigNumber(parseFloat(webhook.amount)),
                    },
                }
            }

            // Handle refund webhooks from PayU
            // Note: MedusaJS manages refund state internally, this is for logging/reconciliation
            if (status === "refund" || status === "refunded") {
                this.logger_?.info?.(
                    `PayU webhook: REFUND processed for txnid=${webhook.txnid}, ` +
                    `mihpayid=${webhook.mihpayid || 'N/A'}, amount=${webhook.amount}`
                )
                // Refunds are managed by MedusaJS through refundPayment method
                // This webhook confirms PayU processed the refund
                return { action: "not_supported" }
            }

            // Handle dispute/chargeback webhooks from PayU
            // TODO: Implement dispute handling workflow
            if (status === "dispute" || status === "chargeback") {
                this.logger_?.warn?.(
                    `PayU webhook: ⚠️ DISPUTE/CHARGEBACK received for txnid=${webhook.txnid}, ` +
                    `mihpayid=${webhook.mihpayid || 'N/A'}, amount=${webhook.amount}. ` +
                    `Manual review required!`
                )
                // Disputes need manual handling - log for now
                return { action: "not_supported" }
            }

            // Handle pending or other statuses
            this.logger_?.info?.(`PayU webhook: Unhandled status '${webhook.status}' for txnid=${webhook.txnid}`)
            return { action: "not_supported" }
        } catch (error) {
            this.logger_?.error?.(
                `PayU webhook processing error: ${error instanceof Error ? error.message : String(error)}`
            )
            return { action: "not_supported" }
        }
    }
}

export default PayuPaymentProviderService
