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
    cast wallet import meadow-deployer --interactive   # paste key ONCE, into cast

Set env and broadcast:
    export PROJECT_TOKEN=0x...            # launched on Pons
    # three funded stocks only (AAPL, NVDA, AMZN); order matches onchain.json stock_idx
    export STOCKS=0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,0x12f190a9F9d7D37a250758b26824B97CE941bF54
    export REWARD_END=$(($(date +%s) + 365*24*3600))   # 1 year from now
    export OWNER=0x598597a5056438Ac9A7206E2C36B0553fc7e34C7   # the meadow Safe (1/1, Robinhood Chain)

    forge script script/DeployMeadowArt.s.sol \
      --rpc-url https://rpc.mainnet.chain.robinhood.com \
      --account meadow-deployer \
      --broadcast

Copy the deployed MeadowArt address from the broadcast output.

## Fund the treasury

Transfer the stock amounts your economics require to the MeadowArt address, per
stock. Example for one stock (repeat per stock, amount in wei, 18 decimals):
    cast send <STOCK_ADDR> "transfer(address,uint256)" <MEADOWART> <AMOUNT_WEI> \
      --rpc-url https://rpc.mainnet.chain.robinhood.com --account meadow-deployer

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

## MeadowMarket (secondary market)

MeadowMarket is a separate, non-custodial contract for reselling pieces after
the initial MeadowArt.buy(). A seller never sends the piece to the market;
they approve it and the market moves seller -> buyer only inside buy(). The
market never holds a piece and never holds the payment token beyond a single
buy() call, so there is no withdraw function and nothing to fund.

### Deploy

Requires MeadowArt already deployed (ART below) and a payment ERC20 (PAY,
does not have to be the same token MeadowArt prices pieces in):

    export ART=<MEADOWART>                          # from the MeadowArt deploy above
    export PAY=<PAYMENT_TOKEN>                       # ERC20 buyers pay in on the secondary market
    export FEE_BPS=250                               # 2.5%; hard cap is 1000 (10%)
    export FEE_RECIPIENT=0x598597a5056438Ac9A7206E2C36B0553fc7e34C7   # the meadow Safe
    export OWNER=0x598597a5056438Ac9A7206E2C36B0553fc7e34C7           # the meadow Safe

    forge script script/DeployMeadowMarket.s.sol \
      --rpc-url https://rpc.mainnet.chain.robinhood.com \
      --account meadow-deployer \
      --broadcast

Copy the deployed MeadowMarket address from the broadcast output.

### Verify

Blockscout: https://robinhoodchain.blockscout.com/address/<MEADOWMARKET>
Sanity: `cast call <MEADOWMARKET> "art()" --rpc-url ...` should return ART,
and `cast call <MEADOWMARKET> "pay()" --rpc-url ...` should return PAY.

### Go live on the site

A seller must call `art.approve(MEADOWMARKET, tokenId)` (or
`setApprovalForAll(MEADOWMARKET, true)`) before `list()` will accept the
listing; the frontend should check `art.isApprovedForAll` first and prompt
for approval if it is false. Use `listingsMany(ids)` to read all pieces'
listings in one call. Add the MeadowMarket address to config.js once the
frontend wiring is ready; do not flip it live until a real buy on mainnet has
been verified end to end (list, approve `pay`, buy, confirm the piece moved
and the fee split landed).

Claim before you list: MeadowArt resets a piece's reward accrual to the
transfer timestamp on every ownership change, and it has no owner-change
settlement, so any stock accrued and unclaimed at sale time is forfeited, not
paid to the seller. The list screen should surface `art.claimable(tokenId)`
and prompt a `claim()` first if it is nonzero.

## Vol. 2 (MeadowArtV2)

Deployed 2026-08-26, block 46493057, tx
0xb9edd680971a07a3517924c20c6f8438a1d75815ee998622c21d2da5b694faca:

    MeadowArtV2  0xf9d6ff6423Af6d21e2F8bC93542630a41FE1303D   (config.js art2)
    owner        0x598597a5056438Ac9A7206E2C36B0553fc7e34C7   (the Safe)
    stocks       AAPL, NVDA, AMZN in that order (onchain2.json stock_idx)
    base URI     https://elizendevvini.github.io/meadow/art/v2/meta/  (set in the constructor)
    reward end   1819273781 (365 days from deploy)

Differences from Vol. 1: one mint per wallet (hasMinted, permanent; resales are
not capped), tokenURI/contractURI for marketplaces, and the base URI is a
constructor argument (BASE_URI env in DeployMeadowArtV2), so the Safe never
has to send setBaseURI.

### Treasury (not funded yet)

Claims pay 0 until the contract holds stock. The committed rates need, for a
full 365-day period across all 30 pieces:

    NVDA  0.0513 shares
    AMZN  0.0421 shares
    AAPL  0.0355 shares

Fund per stock, from the wallet holding the tokenized stock:
    cast send <STOCK_ADDR> "transfer(address,uint256)" 0xf9d6ff6423Af6d21e2F8bC93542630a41FE1303D <AMOUNT_WEI> \
      --rpc-url https://rpc.mainnet.chain.robinhood.com --account meadow-deployer

availablePayout clamps to the contract balance, so partial funding pays out
partially rather than reverting. Withdrawals are owner-only (the Safe).

### Secondary market for Vol. 2

MeadowMarket binds to one ERC-721, so Vol. 2 needs its own deploy:
ART=0xf9d6ff6423Af6d21e2F8bC93542630a41FE1303D, same PAY/FEE/OWNER as above.
Put the address in config.js `market2`; the market page reads every volume
whose `market` is set.
