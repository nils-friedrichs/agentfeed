// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// HoneypotSim — never deployed. AgentFeed places this runtime code at a throwaway address
// with an eth_call state override and calls run() once: buy the token with a small amount
// of its quote asset on one pool, then sell everything it received back into the same
// pool (99% of the balance). Nothing is broadcast; the chain is read, never written.
//
// Measured per leg: whether it reverted (and the revert data), what the pool said it
// would send, what actually arrived, gas used. A transfer tax shows up as "arrived less
// than the pool sent" (buy) or "the pool received less than we sent" (sell).
//
// kind 1 = Uniswap V2 / PancakeSwap V2 pair (fee in bps), 2 = Aerodrome v2 pool (getAmountOut),
// 3 = Uniswap V3 / PancakeSwap V3 / Aerodrome Slipstream pool, 4 = Uniswap V4 pool (PoolManager).
// wnative is the chain's wrapped native token (WETH, WBNB): a quote equal to it is funded
// by depositing the simulator's overridden native balance.

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
}

interface IWETH {
    function deposit() external payable;
}

interface IPairLike {
    function getReserves() external view returns (uint256, uint256, uint256);
    function token0() external view returns (address);
    function swap(uint256, uint256, address, bytes calldata) external;
    function getAmountOut(uint256, address) external view returns (uint256);
}

interface IV3Pool {
    function token0() external view returns (address);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(PoolKey memory, SwapParams memory, bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address, address, uint256) external;
}

contract HoneypotSim {
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    struct Leg {
        bool ok;
        bytes err;
        uint256 sent;      // amount we put in
        uint256 arrived;   // amount the pool actually credited (sell) / pool said it sends (buy)
        uint256 received;  // amount that reached us
        uint256 gasUsed;
    }

    struct Result {
        Leg buy;
        Leg sell;
        bool transferOk;
        bytes transferErr;
    }

    address internal cbPool;      // the V3 pool we expect a callback from
    address internal pm;          // the V4 PoolManager we expect a callback from

    receive() external payable {}

    function run(uint8 kind, address pool, address token, address quote, uint256 amountIn, uint256 feeBps, bytes calldata v4, address wnative) external returns (Result memory r) {
        if (wnative != address(0) && quote == wnative) IWETH(wnative).deposit{value: amountIn}();

        uint256 g = gasleft();
        try this.buyLeg(kind, pool, token, quote, amountIn, feeBps, v4) returns (uint256 arrived, uint256 received) {
            r.buy = Leg(true, "", amountIn, arrived, received, g - gasleft());
        } catch (bytes memory e) {
            r.buy = Leg(false, e, amountIn, 0, 0, g - gasleft());
            return r;
        }
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return r;

        // wallet-to-wallet transfer of 1% (at least 1 unit): a token that blocks plain transfers
        uint256 t = bal / 100;
        if (t == 0) t = 1;
        try this.transferLeg(token, t) {
            r.transferOk = true;
        } catch (bytes memory e) {
            r.transferErr = e;
        }
        // sell 99% of what is left: a token that keeps dust or charges the sender on top of
        // the amount must not read as unsellable because we tried to move every last unit
        bal = IERC20(token).balanceOf(address(this));
        bal -= bal / 100;

        g = gasleft();
        try this.sellLeg(kind, pool, token, quote, bal, feeBps, v4) returns (uint256 arrived, uint256 received) {
            r.sell = Leg(true, "", bal, arrived, received, g - gasleft());
        } catch (bytes memory e) {
            r.sell = Leg(false, e, bal, 0, 0, g - gasleft());
        }
    }

    function transferLeg(address token, uint256 amount) external {
        require(msg.sender == address(this), "self");
        _transfer(token, address(0x000000000000000000000000000000000000dEaD), amount);
    }

    // ---- buy: quote -> token ----
    function buyLeg(uint8 kind, address pool, address token, address quote, uint256 amountIn, uint256 feeBps, bytes calldata v4) external returns (uint256 arrived, uint256 received) {
        require(msg.sender == address(this), "self");
        uint256 before = IERC20(token).balanceOf(address(this));
        if (kind == 1 || kind == 2) {
            arrived = _pairOut(kind, pool, quote, amountIn, feeBps);
            _transfer(quote, pool, amountIn);
            _pairSwap(pool, token, arrived);
        } else if (kind == 3) {
            arrived = _v3(pool, quote, amountIn);
        } else if (kind == 4) {
            arrived = _v4(true, token, quote, amountIn, v4);
        } else {
            revert("kind");
        }
        received = IERC20(token).balanceOf(address(this)) - before;
    }

    // ---- sell: token -> quote ----
    function sellLeg(uint8 kind, address pool, address token, address quote, uint256 amountIn, uint256 feeBps, bytes calldata v4) external returns (uint256 arrived, uint256 received) {
        require(msg.sender == address(this), "self");
        uint256 before = _bal(quote);
        if (kind == 1 || kind == 2) {
            (uint256 r0, uint256 r1, ) = IPairLike(pool).getReserves();
            uint256 reserveIn = IPairLike(pool).token0() == token ? r0 : r1;
            _transfer(token, pool, amountIn);
            arrived = IERC20(token).balanceOf(pool) - reserveIn;   // what the pool really got
            uint256 out = _pairOut(kind, pool, token, arrived, feeBps);
            _pairSwap(pool, quote, out);
        } else if (kind == 3) {
            _v3(pool, token, amountIn);
            arrived = amountIn;   // a V3 pool reverts unless it receives the full amount
        } else if (kind == 4) {
            arrived = _v4(false, token, quote, amountIn, v4);
        } else {
            revert("kind");
        }
        received = _bal(quote) - before;
    }

    function _bal(address a) internal view returns (uint256) {
        return a == address(0) ? address(this).balance : IERC20(a).balanceOf(address(this));
    }

    function _pairOut(uint8 kind, address pool, address tokenIn, uint256 amountIn, uint256 feeBps) internal view returns (uint256) {
        if (kind == 2) return IPairLike(pool).getAmountOut(amountIn, tokenIn);
        (uint256 r0, uint256 r1, ) = IPairLike(pool).getReserves();
        bool in0 = IPairLike(pool).token0() == tokenIn;
        (uint256 rIn, uint256 rOut) = in0 ? (r0, r1) : (r1, r0);
        uint256 a = amountIn * (10000 - feeBps);
        return (a * rOut) / (rIn * 10000 + a);
    }

    function _pairSwap(address pool, address tokenOut, uint256 out) internal {
        bool out0 = IPairLike(pool).token0() == tokenOut;
        IPairLike(pool).swap(out0 ? out : 0, out0 ? 0 : out, address(this), "");
    }

    // ---- V3 / Slipstream: exact input; returns what the pool says it sends ----
    function _v3(address pool, address tokenIn, uint256 amountIn) internal returns (uint256 poolOut) {
        bool zeroForOne = IV3Pool(pool).token0() == tokenIn;
        cbPool = pool;
        (int256 a0, int256 a1) = IV3Pool(pool).swap(address(this), zeroForOne, int256(amountIn), zeroForOne ? MIN_SQRT : MAX_SQRT, abi.encode(tokenIn));
        cbPool = address(0);
        int256 o = zeroForOne ? a1 : a0;
        poolOut = uint256(-o);
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _payCallback(a0, a1, data);
    }

    // PancakeSwap V3 pools call their own name; same contract otherwise.
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _payCallback(a0, a1, data);
    }

    function _payCallback(int256 a0, int256 a1, bytes calldata data) internal {
        require(msg.sender == cbPool, "cb");
        address tokenIn = abi.decode(data, (address));
        uint256 owed = uint256(a0 > 0 ? a0 : a1);
        _transfer(tokenIn, msg.sender, owed);
    }

    // ---- V4: settle the input first (so a transfer tax is measured as a short credit), then swap exact input, then take ----
    function _v4(bool isBuy, address token, address quote, uint256 amountIn, bytes calldata v4) internal returns (uint256) {
        (address manager, PoolKey memory key) = abi.decode(v4, (address, PoolKey));
        pm = manager;
        bytes memory out = IPoolManager(manager).unlock(abi.encode(isBuy, token, quote, amountIn, key));
        pm = address(0);
        return abi.decode(out, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == pm, "pm");
        (bool isBuy, address token, address quote, uint256 amountIn, PoolKey memory key) = abi.decode(data, (bool, address, address, uint256, PoolKey));
        IPoolManager m = IPoolManager(msg.sender);
        address cin = isBuy ? quote : token;
        address cout = isBuy ? token : quote;
        uint256 credited;
        if (cin == address(0)) {
            credited = m.settle{value: amountIn}();
        } else {
            m.sync(cin);
            _transfer(cin, msg.sender, amountIn);
            credited = m.settle();
        }
        bool zeroForOne = key.currency0 == cin;
        int256 delta = m.swap(key, SwapParams(zeroForOne, -int256(credited), zeroForOne ? MIN_SQRT : MAX_SQRT), "");
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        int128 o = zeroForOne ? d1 : d0;
        uint256 owedOut = uint256(uint128(o));
        m.take(cout, address(this), owedOut);
        // buy: what the pool sends; sell: what the pool was credited
        return abi.encode(isBuy ? owedOut : credited);
    }

    function _transfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), "transfer false");
    }
}
