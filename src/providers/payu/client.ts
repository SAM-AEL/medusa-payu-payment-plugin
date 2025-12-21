/**
 * PayU SDK Client
 * Manual hash implementation based on PayU documentation
 * https://docs.payu.in/docs/generate-hash-merchant-hosted
 */

import crypto from "crypto"
import type { Logger } from "@medusajs/framework/types"
import type { PayuProviderConfig, PayuVerifyResponse, PayuRefundResponse } from "./types"

/**
 * PayU Client for payment operations
 */
export class PayuClient {
    private config: PayuProviderConfig
    private logger?: Logger

    constructor(config: PayuProviderConfig, logger?: Logger) {
        this.config = config
        this.logger = logger
    }

    /**
     * Default API timeout in milliseconds (30 seconds)
     */
    private readonly API_TIMEOUT_MS = 30000

    /**
     * Fetch with timeout to prevent hanging requests
     */
    private async fetchWithTimeout(
        url: string,
        options: RequestInit,
        timeoutMs: number = this.API_TIMEOUT_MS
    ): Promise<Response> {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            })
            return response
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`PayU API request timed out after ${timeoutMs}ms`)
            }
            throw error
        } finally {
            clearTimeout(timeoutId)
        }
    }

    /**
     * Get PayU payment URL
     */
    getPaymentUrl(): string {
        return this.config.environment === "production"
            ? "https://secure.payu.in/_payment"
            : "https://test.payu.in/_payment"
    }

    /**
     * Generate payment hash
     * 
     * Formula from PayU docs:
     * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
     * 
     * Note: "||||||" is a literal string (6 pipes) appended after udf5
     */
    generatePaymentHash(params: {
        txnid: string
        amount: string
        productinfo: string
        firstname: string
        email: string
        udf1?: string
        udf2?: string
        udf3?: string
        udf4?: string
        udf5?: string
    }): string {
        const key = this.config.merchantKey
        const salt = this.config.merchantSalt
        const udf1 = params.udf1 || ""
        const udf2 = params.udf2 || ""
        const udf3 = params.udf3 || ""
        const udf4 = params.udf4 || ""
        const udf5 = params.udf5 || ""

        // Exact formula from PayU docs:
        // sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
        // The ||||||SALT means 5 empty reserved fields between udf5 and SALT (creating 6 pipes)
        const hashString = `${key}|${params.txnid}|${params.amount}|${params.productinfo}|${params.firstname}|${params.email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${salt}`

        const generatedHash = crypto.createHash("sha512").update(hashString).digest("hex").toLowerCase()

        this.logger?.debug?.(`PayU hash generated for txnid: ${params.txnid}`)

        return generatedHash
    }

    /**
     * Verify response hash from PayU callback/webhook
     * 
     * Reverse hash formula:
     * sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
     */
    verifyResponseHash(params: {
        status: string
        email: string
        firstname: string
        productinfo: string
        amount: string
        txnid: string
        hash: string
        udf1?: string
        udf2?: string
        udf3?: string
        udf4?: string
        udf5?: string
        additionalCharges?: string
    }): boolean {
        const salt = this.config.merchantSalt
        const key = this.config.merchantKey
        const udf1 = params.udf1 || ""
        const udf2 = params.udf2 || ""
        const udf3 = params.udf3 || ""
        const udf4 = params.udf4 || ""
        const udf5 = params.udf5 || ""

        let hashString: string
        if (params.additionalCharges) {
            hashString = `${params.additionalCharges}|${salt}|${params.status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${params.email}|${params.firstname}|${params.productinfo}|${params.amount}|${params.txnid}|${key}`
        } else {
            hashString = `${salt}|${params.status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${params.email}|${params.firstname}|${params.productinfo}|${params.amount}|${params.txnid}|${key}`
        }

        const calculatedHash = crypto.createHash("sha512").update(hashString).digest("hex").toLowerCase()
        return calculatedHash === params.hash.toLowerCase()
    }

    /**
     * Verify payment status with PayU API
     */
    async verifyPayment(txnid: string): Promise<PayuVerifyResponse> {
        const command = "verify_payment"
        const hashString = `${this.config.merchantKey}|${command}|${txnid}|${this.config.merchantSalt}`
        const hash = crypto.createHash("sha512").update(hashString).digest("hex")

        const apiUrl = this.config.environment === "production"
            ? "https://info.payu.in/merchant/postservice.php?form=2"
            : "https://test.payu.in/merchant/postservice.php?form=2"

        const response = await this.fetchWithTimeout(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                key: this.config.merchantKey,
                command: command,
                var1: txnid,
                hash: hash,
            }),
        })

        return response.json() as Promise<PayuVerifyResponse>
    }

    /**
     * Initiate refund
     */
    async refund(
        mihpayid: string,
        tokenId: string,
        amount: string
    ): Promise<PayuRefundResponse> {
        const command = "cancel_refund_transaction"
        const hashString = `${this.config.merchantKey}|${command}|${mihpayid}|${this.config.merchantSalt}`
        const hash = crypto.createHash("sha512").update(hashString).digest("hex")

        const apiUrl = this.config.environment === "production"
            ? "https://info.payu.in/merchant/postservice.php?form=2"
            : "https://test.payu.in/merchant/postservice.php?form=2"

        const response = await this.fetchWithTimeout(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                key: this.config.merchantKey,
                command: command,
                var1: mihpayid,
                var2: tokenId,
                var3: amount,
                hash: hash,
            }),
        })

        return response.json() as Promise<PayuRefundResponse>
    }
}

/**
 * Generate unique transaction ID
 */
export function generateTxnId(): string {
    const timestamp = Date.now()
    const random = crypto.randomBytes(4).toString("hex")
    return `TXN_${timestamp}_${random}`
}
