/* eslint-disable @typescript-eslint/no-non-null-assertion */

import {
  AddLiquidityOptions,
  CollectOptions,
  Ethereum_Query,
  Input_addCallParametersNFPM,
  Input_collectCallParametersNFPM,
  Input_createCallParametersNFPM,
  Input_removeCallParametersNFPM,
  Input_safeTransferFromParametersNFPM,
  MethodParameters,
  MintAmounts,
  Pool,
  Position,
  RemoveLiquidityOptions,
  SafeTransferOptions,
  Token,
  TokenAmount,
} from "./w3";
import {
  encodeMulticall,
  encodePermit,
  encodeRefundETH,
  encodeSweepToken,
  encodeUnwrapWETH9,
  toHex,
} from "./routerUtils";
import { getFeeAmount, getPermitV } from "../utils/utils";
import { ADDRESS_ZERO, ZERO_HEX } from "../utils/constants";
import {
  burnAmountsWithSlippage,
  createPosition,
  mintAmounts,
  mintAmountsWithSlippage,
} from "./position";
import { getChecksumAddress } from "../utils/addressUtils";
import { isEther, wrapToken } from "../utils/tokenUtils";
import { tokenEquals } from "./token";
import Fraction from "../utils/Fraction";

import { BigInt } from "@web3api/wasm-as";

const MAX_UINT_128_HEX = toHex({ value: BigInt.ONE.leftShift(128).subInt(1) });

class MintArgs {
  token0: string;
  token1: string;
  fee: u32;
  tickLower: i32;
  tickUpper: i32;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  recipient: string;
  deadline: string;
}

class IncreaseLiquidityArgs {
  tokenId: string;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  deadline: string;
}

class CollectArgs {
  tokenId: string;
  recipient: string;
  amount0Max: string;
  amount1Max: string;
}

class DecreaseLiquidityArgs {
  tokenId: string;
  liquidity: string;
  amount0Min: string;
  amount1Min: string;
  deadline: string;
}

export function createCallParametersNFPM(
  input: Input_createCallParametersNFPM
): MethodParameters {
  return {
    calldata: encodeCreate(input.pool),
    value: ZERO_HEX,
  };
}

export function addCallParametersNFPM(
  input: Input_addCallParametersNFPM
): MethodParameters {
  const position: Position = input.position;
  const options: AddLiquidityOptions = input.options;

  if (position.liquidity <= BigInt.ZERO) {
    throw new Error("ZERO_LIQUIDITY: position liquidity must exceed zero");
  }

  const calldatas: string[] = [];

  // get amounts
  const amountsDesired: MintAmounts = mintAmounts({ position });
  const amount0Desired: BigInt = amountsDesired.amount0;
  const amount1Desired: BigInt = amountsDesired.amount1;

  // adjust for slippage
  const minimumAmounts: MintAmounts = mintAmountsWithSlippage({
    position,
    slippageTolerance: options.slippageTolerance,
  });
  const amount0Min: string = toHex({ value: minimumAmounts.amount0 });
  const amount1Min: string = toHex({ value: minimumAmounts.amount1 });

  const deadline: string = toHex({ value: options.deadline });

  // create pool if needed
  if (isMint(options) && !options.createPool.isNull) {
    calldatas.push(encodeCreate(position.pool));
  }

  // permits if necessary
  if (options.token0Permit !== null) {
    calldatas.push(
      encodePermit({
        token: position.pool.token0,
        options: options.token0Permit!,
      })
    );
  }
  if (options.token1Permit !== null) {
    calldatas.push(
      encodePermit({
        token: position.pool.token1,
        options: options.token1Permit!,
      })
    );
  }

  // mint
  if (isMint(options)) {
    const args: MintArgs = {
      token0: position.pool.token0.address,
      token1: position.pool.token1.address,
      fee: getFeeAmount(position.pool.fee),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      amount0Desired: toHex({ value: amount0Desired }),
      amount1Desired: toHex({ value: amount1Desired }),
      amount0Min,
      amount1Min,
      recipient: getChecksumAddress(options.recipient!),
      deadline,
    };
    calldatas.push(
      Ethereum_Query.encodeFunction({
        method: nfpmAbi("mint"),
        args: [stringifyParams(args)],
      })
    );
  } else {
    // increase
    const args: IncreaseLiquidityArgs = {
      tokenId: toHex({ value: options.tokenId! }),
      amount0Desired: toHex({ value: amount0Desired }),
      amount1Desired: toHex({ value: amount1Desired }),
      amount0Min,
      amount1Min,
      deadline,
    };
    calldatas.push(
      Ethereum_Query.encodeFunction({
        method: nfpmAbi("increaseLiquidity"),
        args: [stringifyParams(args)],
      })
    );
  }

  let value: string = ZERO_HEX;
  if (options.useNative !== null) {
    const wrapped: Token = wrapToken(options.useNative!);
    const isToken0: boolean = tokenEquals({
      tokenA: position.pool.token0,
      tokenB: wrapped,
    });
    const isToken1: boolean = tokenEquals({
      tokenA: position.pool.token1,
      tokenB: wrapped,
    });
    if (!isToken0 && !isToken1) {
      throw new Error(
        "NO_WETH: the native token provided with the useNative option must be involved in the position pool"
      );
    }

    const wrappedValue: BigInt = isToken0 ? amount0Desired : amount1Desired;

    // we only need to refund if we're actually sending ETH
    if (wrappedValue > BigInt.ZERO) {
      calldatas.push(encodeRefundETH());
    }

    value = toHex({ value: wrappedValue });
  }

  return {
    calldata: encodeMulticall({ calldatas }),
    value,
  };
}

export function collectCallParametersNFPM(
  input: Input_collectCallParametersNFPM
): MethodParameters {
  const calldatas: string[] = encodeCollect(input.options);
  return {
    calldata: encodeMulticall({ calldatas }),
    value: ZERO_HEX,
  };
}

/**
 * Produces the calldata for completely or partially exiting a position
 * @param input.position The position to exit
 * @param input.options Additional information necessary for generating the calldata
 */
export function removeCallParametersNFPM(
  input: Input_removeCallParametersNFPM
): MethodParameters {
  const position: Position = input.position;
  const options: RemoveLiquidityOptions = input.options;

  const calldatas: string[] = [];

  const deadline: string = toHex({ value: options.deadline });
  const tokenId: string = toHex({ value: options.tokenId });
  const liqPercent: Fraction = Fraction.fromString(options.liquidityPercentage);

  // construct a partial position with a percentage of liquidity
  const partialPosition = createPosition({
    pool: position.pool,
    liquidity: liqPercent.mul(new Fraction(position.liquidity)).quotient(),
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
  });
  if (partialPosition.liquidity <= BigInt.ZERO) {
    throw new Error("ZERO_LIQUIDITY");
  }

  // slippage-adjusted underlying amounts
  const burnAmounts: MintAmounts = burnAmountsWithSlippage({
    position: partialPosition,
    slippageTolerance: options.slippageTolerance,
  });
  const amount0Min: BigInt = burnAmounts.amount0;
  const amount1Min: BigInt = burnAmounts.amount1;

  if (options.permit !== null) {
    calldatas.push(
      Ethereum_Query.encodeFunction({
        method: "permit",
        args: [
          getChecksumAddress(options.permit!.spender),
          tokenId,
          toHex({ value: options.permit!.deadline }),
          getPermitV(options.permit!.v).toString(),
          options.permit!.r,
          options.permit!.s,
        ],
      })
    );
  }

  // remove liquidity
  const decreaseLiqArgs: DecreaseLiquidityArgs = {
    tokenId,
    liquidity: toHex({ value: partialPosition.liquidity }),
    amount0Min: toHex({ value: amount0Min }),
    amount1Min: toHex({ value: amount1Min }),
    deadline,
  };
  calldatas.push(
    Ethereum_Query.encodeFunction({
      method: "decreaseLiquidity",
      args: [stringifyParams(decreaseLiqArgs)],
    })
  );

  const expectedCurrencyOwed0: TokenAmount =
    options.collectOptions.expectedCurrencyOwed0;
  const expectedCurrencyOwed1: TokenAmount =
    options.collectOptions.expectedCurrencyOwed1;
  calldatas.concat(
    encodeCollect({
      tokenId: options.tokenId,
      // add the underlying value to the expected currency already owed
      expectedCurrencyOwed0: {
        token: expectedCurrencyOwed0.token,
        amount: expectedCurrencyOwed0.amount.add(amount0Min),
      },
      expectedCurrencyOwed1: {
        token: expectedCurrencyOwed1.token,
        amount: expectedCurrencyOwed1.amount.add(amount1Min),
      },
      recipient: options.collectOptions.recipient,
    })
  );

  if (liqPercent.eq(new Fraction(BigInt.ONE))) {
    if (!options.burnToken.isNull && options.burnToken.value) {
      calldatas.push(
        Ethereum_Query.encodeFunction({ method: "burn", args: [tokenId] })
      );
    }
  } else {
    if (!options.burnToken.isNull && options.burnToken.value) {
      throw new Error(
        "CANNOT_BURN: cannot burn tokens if liquidity percentage equals 100%"
      );
    }
  }

  return {
    calldata: encodeMulticall({ calldatas }),
    value: ZERO_HEX,
  };
}

export function safeTransferFromParametersNFPM(
  input: Input_safeTransferFromParametersNFPM
): MethodParameters {
  const options: SafeTransferOptions = input.options;

  const recipient: string = getChecksumAddress(options.recipient);
  const sender: string = getChecksumAddress(options.sender);

  // TODO: can i simplify safeTransferFrom calls by sending empty string with first function?
  let calldata: string;
  if (options.data !== null) {
    calldata = Ethereum_Query.encodeFunction({
      method: nfpmAbi("safeTransferFrom"),
      args: [
        sender,
        recipient,
        toHex({ value: options.tokenId }),
        options.data!,
      ],
    });
  } else {
    calldata = Ethereum_Query.encodeFunction({
      method: nfpmAbi("_safeTransferFrom"),
      args: [sender, recipient, toHex({ value: options.tokenId })],
    });
  }

  return {
    calldata: calldata,
    value: ZERO_HEX,
  };
}

function isMint(options: AddLiquidityOptions): boolean {
  return options.recipient !== null;
}

function encodeCreate(pool: Pool): string {
  return Ethereum_Query.encodeFunction({
    method: "createAndInitializePoolIfNecessary",
    args: [
      pool.token0.address,
      pool.token1.address,
      getFeeAmount(pool.fee).toString(),
      toHex({ value: pool.sqrtRatioX96 }),
    ],
  });
}

function encodeCollect(options: CollectOptions): string[] {
  const calldatas: string[] = [];

  const tokenId: string = toHex({ value: options.tokenId });
  const recipient: string = getChecksumAddress(options.recipient);
  const involvesETH: boolean =
    isEther(options.expectedCurrencyOwed0.token) ||
    isEther(options.expectedCurrencyOwed1.token);

  // collect
  const collectArgs: CollectArgs = {
    tokenId,
    recipient: involvesETH ? ADDRESS_ZERO : recipient,
    amount0Max: MAX_UINT_128_HEX,
    amount1Max: MAX_UINT_128_HEX,
  };
  calldatas.push(
    Ethereum_Query.encodeFunction({
      method: "collect",
      args: [stringifyParams(collectArgs)],
    })
  );

  if (involvesETH) {
    const ethAmount: BigInt = isEther(options.expectedCurrencyOwed0.token)
      ? options.expectedCurrencyOwed0.amount
      : options.expectedCurrencyOwed1.amount;
    const token: Token = isEther(options.expectedCurrencyOwed0.token)
      ? options.expectedCurrencyOwed1.token
      : options.expectedCurrencyOwed0.token;
    const tokenAmount: BigInt = isEther(options.expectedCurrencyOwed0.token)
      ? options.expectedCurrencyOwed1.amount
      : options.expectedCurrencyOwed0.amount;

    calldatas.push(
      encodeUnwrapWETH9({
        amountMinimum: ethAmount,
        recipient,
        feeOptions: null,
      })
    );
    calldatas.push(
      encodeSweepToken({
        token,
        amountMinimum: tokenAmount,
        recipient,
        feeOptions: null,
      })
    );
  }

  return calldatas;
}

function nfpmAbi(methodName: string): string {
  if (methodName == "createAndInitializePoolIfNecessary") {
    return "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)";
  } else if (methodName == "collect") {
    return "function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1)";
  } else if (methodName == "mint") {
    return "function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)";
  } else if (methodName == "increaseLiquidity") {
    return "function increaseLiquidity(IncreaseLiquidityParams calldata params) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)";
  } else if (methodName == "permit") {
    return "function permit(address spender, uint256  deadline, bytes32 r, bytes32 s) external payable";
  } else if (methodName == "decreaseLiquidity") {
    return "function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256 amount0, uint256 amount1)";
  } else if (methodName == "burn") {
    return "function burn(uint256 tokenId) external payable";
  } else if (methodName == "safeTransferFrom") {
    return "safeTransferFrom(address,address,uint256,bytes)";
  } else if (methodName == "_safeTransferFrom") {
    return "safeTransferFrom(address,address,uint256)";
  } else {
    throw new Error("Invalid method name: " + methodName);
  }
}

function stringifyParams<T>(params: T): string {
  if (params instanceof MintArgs) {
    return `{
      token0: ${params.token0},
      token1: ${params.token1},
      fee: ${params.fee},
      tickLower: ${params.tickLower},
      tickUpper: ${params.tickUpper},
      amount0Desired: ${params.amount0Desired},
      amount1Desired: ${params.amount1Desired},
      amount0Min: ${params.amount0Min},
      amount1Min: ${params.amount1Min},
      recipient: ${params.recipient},
      deadline: ${params.deadline},
    }`;
  } else if (params instanceof IncreaseLiquidityArgs) {
    return `{
      tokenId: ${params.tokenId},
      amount0Desired: ${params.amount0Desired},
      amount1Desired: ${params.amount1Desired},
      amount0Min: ${params.amount0Min},
      amount1Min: ${params.amount1Min},
      deadline: ${params.deadline},
    }`;
  } else if (params instanceof CollectArgs) {
    return `{
      tokenId: ${params.tokenId},
      recipient: ${params.recipient},
      amount0Max: ${params.amount0Max},
      amount1Max: ${params.amount1Max},
    }`;
  } else if (params instanceof DecreaseLiquidityArgs) {
    return `{
      tokenId: ${params.tokenId},
      liquidity: ${params.liquidity},
      amount0Min: ${params.amount0Min},
      amount1Min: ${params.amount1Min},
      deadline: ${params.deadline},
    }`;
  } else {
    throw new Error("unknown router parameters type");
  }
}
