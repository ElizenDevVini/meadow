# MeadowArt mainnet deploy runbook (Robinhood Chain, chain id 4663)

You run every step here with your own wallet. I never touch mainnet or your keys.
Nothing below is reversible cheaply, so read the whole file first.

## Before you touch mainnet: three decisions

1. Payment token. buy(id) charges the project token via transferFrom, so a token
   must exist first. Launch it on Pons v2 (https://www.ponsfamily.com/launchpad)
   and copy its address. If you would rather price pieces in an existing asset
   (native ETH, or a tokenized stock), that is a contract change, tell me and I
   will adjust MeadowArt before you deploy.

2. Owner wallet. The owner holds the sale proceeds and the stock treasury and can
   withdraw both. For a contract custodying real securities, use a Safe multisig
   or a dedicated hardware-wallet key, never a hot key you have pasted anywhere.

3. Reward economics: rates are now VALUE-TIED. A piece bought for
   (price_tokens * MDW_PRICE_USD) dollars pays ANNUAL_YIELD_BPS of that value per
   year, converted into the assigned stock at its own price. You MUST regenerate
   art/data/onchain.json with the real numbers once the token trades, because the
   committed defaults (MDW $0.02, every stock $250, 4%) are placeholders:
     MDW_PRICE_USD=0.10 \
     STOCK_PRICES_USD="TSLA:340,AAPL:230,NVDA:180,MSFT:430,AMZN:220" \
     ANNUAL_YIELD_BPS=300 \
     python3 ../tools/gen_art_onchain.py
   Then recompute the treasury: sum(rate_wei) * reward_seconds per stock. At MDW
   $0.10 / 3% this is under 1 share/year total across all 50 pieces; scale the
   yield or the MDW price to the payout you want. Fund at least that much.

## Securities note

Streaming real tokenized stocks (AAPL, NVDA, TSLA, MSFT, AMZN) to the public in
exchange for a token is a securities-law exposure. Get legal review. This is your
decision; the code builds the mechanism, it does not make it compliant.

## Prerequisites

- Foundry installed; deps restored: `cp -R ../../utopia-landing/contracts/lib ./lib`
- Real ETH for gas in the OWNER wallet on Robinhood Chain (bridge in).
- The launched project token address, and enough of each tokenized stock to fund
  the treasury for your chosen economics.
- The five mainnet stock token addresses, IN THIS ORDER (onchain.json stock_idx
  indexes into this list):
  TSLA 0x322F0929c4625eD5bAd873c95208D54E1c003b2d
  AAPL 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9
  NVDA 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
  MSFT 0xe93237C50D904957Cf27E7B1133b510C669c2e74
  AMZN 0x12f190a9F9d7D37a250758b26824B97CE941bF54
  (GME is not on this list; it is excluded until a real address is confirmed.)

## Deploy

Store your key in a keystore, do not paste it anywhere:
    cast wallet import meadow-owner --interactive   # paste key ONCE, into cast

Set env and broadcast:
    export PROJECT_TOKEN=0x...            # launched on Pons
    export STOCKS=0x322F0929c4625eD5bAd873c95208D54E1c003b2d,0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,0xe93237C50D904957Cf27E7B1133b510C669c2e74,0x12f190a9F9d7D37a250758b26824B97CE941bF54
    export REWARD_END=$(($(date +%s) + 365*24*3600))   # 1 year from now
    export OWNER=0x598597a5056438Ac9A7206E2C36B0553fc7e34C7   # the meadow Safe (1/1, Robinhood Chain)

    forge script script/DeployMeadowArt.s.sol \
      --rpc-url https://rpc.mainnet.chain.robinhood.com \
      --account meadow-owner \
      --broadcast

Copy the deployed MeadowArt address from the broadcast output.

## Fund the treasury

Transfer the stock amounts your economics require to the MeadowArt address, per
stock. Example for one stock (repeat per stock, amount in wei, 18 decimals):
    cast send <STOCK_ADDR> "transfer(address,uint256)" <MEADOWART> <AMOUNT_WEI> \
      --rpc-url https://rpc.mainnet.chain.robinhood.com --account meadow-owner

A piece cannot be claimed against an unfunded stock (availablePayout clamps to
the contract balance), so fund before you announce.

## Verify

Blockscout: https://robinhoodchain.blockscout.com/address/<MEADOWART>
Sanity: `cast call <MEADOWART> "priceOf(uint256)" 0 --rpc-url ...` should match
onchain.json works[0].price_wei.

## Go live on the site

Edit /Users/ash/meadow/config.js and fill the addresses:
    token: '<PROJECT_TOKEN>',
    art:   '<MEADOWART>',
    stocks: [ {symbol:'TSLA',address:'0x322F...'}, ... all five in the same order ]
NET.ready flips true automatically, the nav shows "connect wallet" instead of
"not live yet", and buy/claim activate. Also fill the addresses in
art/data/onchain.json (stocks[].address and project_token) for display. Commit,
push, let Pages redeploy. Do NOT flip this live until the browser buy proof is
green.

## Keys

Never paste a private key into chat or a file. Use the cast keystore or a
hardware wallet. A key pasted in chat on another project had to be treated as
public; do not repeat that.
