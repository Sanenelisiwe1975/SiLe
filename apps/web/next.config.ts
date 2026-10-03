import type { NextConfig } from 'next'

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@sile/sdk', '@sile/shared', '@sile/abi'],
}

export default config
