# meadow contracts

MeadowArt: ERC-721 of the catalog artworks. Buy a piece with the project token,
hold it to stream a claimable tokenized-stock payout. Earning follows the piece
on transfer. A multiplier() hook is reserved for the art-market index oracle
(inert at 1x until wired).

Deps are gitignored. Restore before building:

    cp -R ../../utopia-landing/contracts/lib ./lib   # forge-std + openzeppelin
    # or: forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts

Then: forge build && forge test

Per-work prices and stock assignments come from ../art/data/onchain.json, built
by ../tools/gen_art_onchain.py from the catalog. The deploy script reads env
vars (PROJECT_TOKEN, STOCKS, REWARD_END, OWNER) and that json. Deploy is the
owner's action with their own key; nothing here is deployed to mainnet.
