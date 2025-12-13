/**
 * PayU Payment Provider Service
 * MedusaJS 2 Payment Provider for PayU India
 * 
 * Implements redirect-based payment flow using official payu-websdk
 */

import {
    AbstractPaymentProvider,
    BigNumber,
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
            const email = customer?.email || "customer@example.com"
            const firstname = customer?.first_name || "Customer"
            const phone = customer?.phone || ""
            const productinfo = (input.data as Record<string, string>)?.productinfo || "Order Payment"

            const storefrontUrl = process.env.STOREFRONT_URL || "http://localhost:8000"
            const countryCode = (input.data as Record<string, string>)?.country_code || "in"
            const surl = `${storefrontUrl}/${countryCode}/order/confirmed`
            const furl = `${storefrontUrl}/${countryCode}/checkout?payment_status=failed`

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
                throw new Error("No PayU transaction ID found")
            }

            const tokenId = `REF_${sessionData.payuTransactionId}_${Date.now()}`
            const refundAmount = this.formatAmount(input.amount)

            const response = await this.client_.refund(
                sessionData.payuTransactionId,
                tokenId,
                refundAmount
            )

            if (response.status === 1) {
                this.logger_?.info?.(`PayU refund successful: ${sessionData.txnid}`)
                return {
                    data: {
                        ...sessionData,
                        status: "refunded" as PayuPaymentStatus,
                        refund: { tokenId, amount: refundAmount, response },
                    } as unknown as Record<string, unknown>,
                }
            }

            throw new Error(`Refund failed: ${response.msg}`)
        } catch (error) {
            this.logger_?.error?.(`PayU refundPayment error: ${error}`)
            throw error
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
                const storefrontUrl = process.env.STOREFRONT_URL || "http://localhost:8000"

                const hash = this.client_.generatePaymentHash({
                    txnid: sessionData.txnid,
                    amount: formattedAmount,
                    productinfo: sessionData.productinfo,
                    firstname: sessionData.firstname,
                    email: sessionData.email,
                })

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
                            surl: `${storefrontUrl}/${sessionData.countryCode || 'in'}/order/confirmed`,
                            furl: `${storefrontUrl}/${sessionData.countryCode || 'in'}/checkout?payment_status=failed`,
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
     */
    async getWebhookActionAndData(data: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
        try {
            const webhook = data.data as unknown as PayuWebhookPayload

            this.logger_?.info?.(`PayU webhook: txnid=${webhook.txnid}, status=${webhook.status}`)

            // Verify hash
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
                this.logger_?.warn?.(`PayU webhook: Invalid hash for ${webhook.txnid}`)
                return { action: "not_supported" }
            }

            const sessionId = webhook.udf1 || webhook.txnid
            const status = webhook.status.toLowerCase()

            if (status === "success") {
                return {
                    action: "authorized",
                    data: {
                        session_id: sessionId,
                        amount: new BigNumber(parseFloat(webhook.amount)),
                    },
                }
            }

            if (status === "failure" || status === "failed") {
                return {
                    action: "failed",
                    data: {
                        session_id: sessionId,
                        amount: new BigNumber(parseFloat(webhook.amount)),
                    },
                }
            }

            return { action: "not_supported" }
        } catch (error) {
            this.logger_?.error?.(`PayU webhook error: ${error}`)
            return { action: "not_supported" }
        }
    }
}

export default PayuPaymentProviderService
