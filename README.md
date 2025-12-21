# PayU Payment Plugin for MedusaJS 2

PayU India payment gateway plugin for MedusaJS 2.x with redirect-based checkout flow.

[![npm version](https://img.shields.io/npm/v/medusa-payu-payment-plugin.svg)](https://www.npmjs.com/package/medusa-payu-payment-plugin)
[![MedusaJS](https://img.shields.io/badge/MedusaJS-2.x-7C3AED)](https://medusajs.com/)
[![PayU India](https://img.shields.io/badge/PayU-India-00B9F1)](https://payu.in/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

## Features

- ✅ **Redirect-based checkout** - Seamless PayU hosted checkout integration
- ✅ **Webhook support** - Automatic payment status updates via PayU webhooks
- ✅ **Refund support** - Full and partial refunds through PayU API
- ✅ **Hash verification** - Secure SHA-512 transaction validation
- ✅ **TypeScript** - Full type safety with comprehensive type definitions
- ✅ **Payment verification workflow** - Built-in workflow for custom payment verification

## Installation

```bash
npm install medusa-payu-payment-plugin
# or
yarn add medusa-payu-payment-plugin
```

## Configuration

### 1. Environment Variables

Add to your `.env` file:

```env
# PayU Credentials
PAYU_MERCHANT_KEY=your_merchant_key
PAYU_MERCHANT_SALT=your_merchant_salt
PAYU_ENVIRONMENT=test  # or "production"

# Redirect URLs
STOREFRONT_URL=http://localhost:8000
PAYU_REDIRECT_URL=/order/confirmed
PAYU_REDIRECT_FAILURE_URL=/checkout?payment_status=failed
```

### 2. MedusaJS Config

Add to your `medusa-config.ts`:

```typescript
import { defineConfig } from "@medusajs/framework/utils"

export default defineConfig({
  // ... other config
  modules: [
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payu-payment-plugin/providers/payu",
            id: "payu",
            options: {
              merchantKey: process.env.PAYU_MERCHANT_KEY,
              merchantSalt: process.env.PAYU_MERCHANT_SALT,
              environment: process.env.PAYU_ENVIRONMENT || "test",
            },
          },
        ],
      },
    },
  ],
})
```

### 3. Enable for Region

In Medusa Admin:
1. Go to **Settings → Regions**
2. Select your region
3. Add `payu` as a payment provider

## Frontend Integration

### Payment Flow Overview

1. Customer selects PayU at checkout
2. Frontend retrieves payment session from cart
3. Frontend creates a form and redirects to PayU
4. Customer completes payment on PayU's hosted page
5. PayU redirects back to your storefront
6. Webhook updates order status automatically

### Required Customer Data

When creating a payment session, the following customer data is **required**:

- **Email** - Customer email address
- **Name** - Customer first name
- **Phone** - Uses fallback chain: customer phone → billing address phone (from context) → shipping address phone

The phone number fallback uses MedusaJS's `PaymentProviderContext` which provides the customer and billing address data. If the billing address phone is not available, pass the shipping address phone when initiating payment:

```typescript
// When creating payment session, include in data:
{
  shipping_address_phone: cart.shipping_address?.phone,
  country_code: "in"  // For URL construction
}
```

### React/Next.js Example

```tsx
"use client"

function PayUPaymentButton({ cart }) {
  const handlePayment = async () => {
    // Get PayU payment session
    const paymentSession = cart.payment_collection?.payment_sessions?.find(
      (session) => session.provider_id === "pp_payu_payu"
    )

    if (!paymentSession?.data?.form_data) {
      console.error("PayU session not found")
      return
    }

    const { form_data, paymentUrl } = paymentSession.data

    // Create and submit hidden form
    const form = document.createElement("form")
    form.method = "POST"
    form.action = paymentUrl

    Object.entries(form_data).forEach(([key, value]) => {
      const input = document.createElement("input")
      input.type = "hidden"
      input.name = key
      input.value = String(value)
      form.appendChild(input)
    })

    document.body.appendChild(form)
    form.submit()
  }

  return (
    <button 
      onClick={handlePayment}
      className="btn-primary"
    >
      Pay with PayU
    </button>
  )
}
```

### Payment Session Structure

The payment session data contains:

```typescript
{
  txnid: string           // Unique transaction ID
  amount: string          // Amount with 2 decimals (e.g., "999.00")
  productinfo: string     // Product/order description
  firstname: string       // Customer first name
  email: string           // Customer email
  phone: string           // Customer phone
  hash: string            // Security hash (SHA-512)
  paymentUrl: string      // PayU checkout URL
  status: string          // Payment status
  form_data: {            // Ready-to-submit form data
    key: string           // Merchant key
    txnid: string
    amount: string
    productinfo: string
    firstname: string
    email: string
    phone: string
    surl: string          // Success redirect URL
    furl: string          // Failure redirect URL
    hash: string
    service_provider: string
  }
}
```

## Webhook Setup

PayU webhooks (S2S callbacks) ensure reliable payment status updates even when browser redirects fail.

### 1. Configure Webhook URL in PayU Dashboard

1. Log in to [PayU Dashboard](https://dashboard.payu.in)
2. Go to **Settings → Webhooks** (or **Developer Settings → Webhooks**)
3. Click **Create Webhook** or **Add Webhook URL**
4. Enter your webhook URL:

```
https://your-backend.com/hooks/payment/payu_payu
```

5. Select events to subscribe:
   - `payment.success` - Payment completed successfully
   - `payment.failed` - Payment failed
   - `payment.pending` - Payment is pending (optional)

6. Save the configuration

### 2. Webhook Security

The plugin automatically handles security:

- **Hash Verification**: Every webhook is verified using SHA-512 reverse hash
- **Formula**: `sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`
- **Tampered webhooks are rejected** and logged for investigation

### 3. Content Type Support

PayU sends webhooks as URL-encoded form data:
- `application/x-www-form-urlencoded`
- `multipart/form-data`

MedusaJS handles both content types automatically.

### 4. What Happens on Webhook

| Status | Action | Result |
|--------|--------|--------|
| `success` | `authorized` | Payment session authorized, cart completed, order created |
| `failure`/`failed` | `failed` | Payment session marked as failed |
| Other | `not_supported` | Logged for debugging, no action taken |

## API Reference

### Provider ID

```
pp_payu_payu
```

### Supported Methods

| Method | Description |
|--------|-------------|
| `initiatePayment` | Creates payment session with hash and form data |
| `authorizePayment` | Verifies payment status with PayU API |
| `capturePayment` | Marks payment as captured (auto-capture enabled) |
| `refundPayment` | Initiates full or partial refund |
| `cancelPayment` | Cancels pending payment |
| `getWebhookActionAndData` | Handles PayU webhook callbacks |

### Exported Workflow

You can use the verify payment workflow in your custom code:

```typescript
import { verifyPayuPaymentWorkflow } from "medusa-payu-payment-plugin/workflows"

// In your API route or subscriber
const { result } = await verifyPayuPaymentWorkflow(container).run({
  input: {
    txnid: "TXN_1234567890_abcd",
  },
})

if (result.success) {
  console.log("Payment status:", result.status)
  console.log("Transaction details:", result.transaction)
}
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PAYU_MERCHANT_KEY` | PayU Merchant Key | Yes |
| `PAYU_MERCHANT_SALT` | PayU Merchant Salt (Salt V1) | Yes |
| `PAYU_ENVIRONMENT` | `test` or `production` | No (default: `test`) |
| `STOREFRONT_URL` | Your storefront base URL (e.g., `http://localhost:8000`) | Yes |
| `PAYU_REDIRECT_URL` | Success redirect path (e.g., `/order/confirmed`) | Yes |
| `PAYU_REDIRECT_FAILURE_URL` | Failure redirect path (e.g., `/checkout?payment_status=failed`) | Yes |

## Testing

Use PayU test credentials in your test environment:

- **Test URL**: https://test.payu.in
- **Test Cards**: [PayU Test Cards Documentation](https://devguide.payu.in/docs/test-integration/test-cards/)

### Common Test Card Numbers

| Card Type | Number | CVV | Expiry |
|-----------|--------|-----|--------|
| Visa | 4012001038443335 | 123 | Any future date |
| Mastercard | 5123456789012346 | 123 | Any future date |

## Troubleshooting

### Hash Mismatch Error

Ensure:
1. You're using the correct Salt version (this plugin uses Salt V1)
2. Amount has exactly 2 decimal places (e.g., `"999.00"`)
3. All mandatory fields match exactly between hash generation and form submission

### Webhook Not Received

1. Verify webhook URL is correct in PayU dashboard
2. Ensure your server is publicly accessible
3. Check server logs for incoming webhook requests
4. Verify SSL certificate is valid (required for production)

### Payment Session Not Found

Ensure:
1. PayU is enabled as a payment provider for the region
2. Payment collection is initialized before accessing session
3. Provider ID is `pp_payu_payu` (includes the prefix)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT © [SAM-AEL](https://github.com/SAM-AEL)

See [LICENSE](LICENSE) for more information.

## Links

- [GitHub Repository](https://github.com/SAM-AEL/medusa-payu-payment-plugin)
- [npm Package](https://www.npmjs.com/package/medusa-payu-payment-plugin)
- [PayU Developer Documentation](https://devguide.payu.in/)
- [MedusaJS Documentation](https://docs.medusajs.com/)
- [Changelog](CHANGELOG.md)
