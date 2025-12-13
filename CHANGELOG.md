# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2024-12-13

### Added
- Comprehensive documentation with frontend integration examples
- Verify PayU payment workflow for custom payment verification
- Configuration validation at startup (throws error if credentials missing)
- Country code support for dynamic success/failure URLs
- Production environment support with proper API endpoints

### Changed
- Improved hash generation with PayU documentation compliance
- Better error logging throughout the payment lifecycle
- Updated TypeScript types for session data and webhook payloads

### Fixed
- Hash verification formula with correct pipe delimiter handling
- Response hash verification for additional charges scenario

## [1.0.0] - 2024-12-01

### Added
- Initial release
- PayU India payment gateway integration for MedusaJS 2.x
- Redirect-based checkout flow (PayU hosted checkout)
- Webhook support for automatic payment status updates
- Full and partial refund support
- Secure SHA-512 hash generation and verification
- TypeScript support with full type definitions
- Support for test and production environments
