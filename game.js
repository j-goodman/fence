const {
	CARD_TYPES,
	BUY_STAGE_SIZE,
	TOTAL_BUY_STAGES,
	MAX_HAND_SIZE,
	STARTING_CREDIT,
	CREDIT_FLOOR,
	CREDIT_CEILING,
	SELL_ROUND_OVERHEAD,
	SELL_ROUND_OVERHEAD_NOTICE_MS,
	HEAT_VALUES,
	TINTED_TYPE_IMAGE_KEYS,
	THEME,
	MAIN_FONT: mainFont,
	QUEUE_ANIMATION_MS,
	HAND_ANIMATION_MS,
	FLIP_PORTION,
	OPENING_DEAL_STAGGER_MS,
	CASH_TICKER_DURATION_MS,
	CASH_TICKER_MIN_SWING,
	CASH_TICKER_CYCLES,
	CARD_HEIGHT_RATIO,
	HOW_TO_PLAY_INTRO,
	HOW_TO_PLAY_HEAT_LINE,
	HOW_TO_PLAY_HEAT_OUTRO,
	HOW_TO_PLAY_OUTRO,
	SELL_HEAT_ROLL_MS,
	SELL_HEAT_LAND_MS,
	SELL_HEAT_FLASH_MS,
	SELL_HEAT_RESULT_HOLD_MS,
	SELL_HEAT_REEL_STAGGER_MS,
	SELL_HEAT_REEL_OVERSHOOT_MS,
	SELL_HEAT_REEL_SETTLE_MS
} = window.FENCE_CONFIG

const {
	buildDeck,
	highestRankInHand,
	marketValueForCard,
	sellValueForCard,
	buyPriceForCard,
	creditDeltaForProfit,
	performanceLabel
} = window.FENCE_LOGIC

const moneyFormatter = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	maximumFractionDigits: 0
})

const canvas = document.querySelector('#game')
const ctx = canvas.getContext('2d')

const state = {
	width: window.innerWidth,
	height: window.innerHeight,
	buttons: [],
	hoveredButtonId: null,
	cardMotions: new Map(),
	queueRenderSlots: new Map(),
	handRenderSlots: new Map(),
	deckRect: null,
	animationFrameId: null,
	lastAnimationTime: 0,
	images: new Map(),
	phase: 'loading',
	roundNumber: 1,
	creditLimit: STARTING_CREDIT,
	roundStartCredit: STARTING_CREDIT,
	cash: STARTING_CREDIT,
	displayedCash: STARTING_CREDIT,
	cashTicker: null,
	savings: 0,
	deck: [],
	dealCursor: 0,
	queue: [],
	hand: [],
	sellPhaseRanks: new Map(),
	sellHeatCheck: null,
	sellRoundTransition: null,
	buySkipTransition: null,
	buyStage: 1,
	showHowToPlay: false,
	openingDealOrder: new Map(),
	bonusInventory: {
		bribes: 0,
		legitimateBusiness: 0,
		expansion: 0
	},
	bribesRemaining: 0,
	pendingBonusPhase: null,
	bribePrompt: null,
	notice: 'Loading the goods...',
	roundResult: null,
	headerBottom: 0,
	footerHeight: 0
}

const tintedTypeImages = new Map()
const BUY_SKIP_NOTICE_MS = 1000
const BUY_QUEUE_CARD_SCALE = 1.25
const BONUS_CARDS = [
	{
		key: 'bribes',
		name: 'Bribes',
		cost: 5000,
		description: 'Buy a re-roll on 1 item confiscation per week.',
		overheadDelta: 200,
		quantity: 3,
		accent: '#9f7c3e',
		imagePath: 'assets/bribe-card.png',
		imageKey: 'bonus-bribes'
	},
	{
		key: 'legitimateBusiness',
		name: 'Legitimate Business',
		cost: 10000,
		description: 'Cut your weekly overhead by two thirds.',
		overheadLabel: 'Minus two thirds.',
		quantity: 1,
		accent: '#3f7b65',
		imagePath: 'assets/legitimate-business-card.png',
		imageKey: 'bonus-legitimate-business'
	},
	{
		key: 'expansion',
		name: 'Expansion',
		cost: 30000,
		description: 'Expand your premises. See 5 cards at a and hold up to 9.',
		overheadDelta: 60,
		quantity: 1,
		accent: '#4c6f9d',
		imagePath: 'assets/expansion-card.png',
		imageKey: 'bonus-expansion'
	}
]
const BONUS_CARD_LOOKUP = new Map(BONUS_CARDS.map(card => [card.key, card]))

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const formatMoney = value => moneyFormatter.format(value)

const formatCompactMoney = value => {
	if (value >= 1000 && value % 1000 === 0) {
		return `$${value / 1000}k`
	}

	return formatMoney(value)
}

const footerHeightForPhase = () => (state.phase === 'summary' ? 0 : clamp(state.height * 0.17, 136, 164))
const bonusOwnedCount = key => state.bonusInventory[key] || 0
const remainingBonusCopies = key => Math.max(0, (BONUS_CARD_LOOKUP.get(key)?.quantity || 0) - bonusOwnedCount(key))
const anyBonusCopiesRemaining = () => BONUS_CARDS.some(card => remainingBonusCopies(card.key) > 0)
const isDebtBonusOffer = card => Boolean(card.bonusCard)
const currentBuyQueueCapacity = () => 4 + bonusOwnedCount('expansion')
const currentMaxHandSize = () => MAX_HAND_SIZE + bonusOwnedCount('expansion') * 3
const baseWeeklyOverhead = () => SELL_ROUND_OVERHEAD + bonusOwnedCount('bribes') * 200 + bonusOwnedCount('expansion') * 60
const currentWeeklyOverhead = () => baseWeeklyOverhead() * ((1 / 3) ** bonusOwnedCount('legitimateBusiness'))

const grantBonusOwnership = bonusKey => {
	state.bonusInventory[bonusKey] = bonusOwnedCount(bonusKey) + 1

	if (bonusKey === 'bribes') {
		state.bribesRemaining = Math.min(3, state.bribesRemaining + 1)
	}
}

const pickDebtBonusOffer = () => {
	const eligibleCards = BONUS_CARDS.filter(card => remainingBonusCopies(card.key) > 0)

	if (eligibleCards.length === 0) {
		return null
	}

	const totalWeight = eligibleCards.reduce((sum, card) => sum + remainingBonusCopies(card.key), 0)
	let target = Math.random() * totalWeight

	for (const card of eligibleCards) {
		target -= remainingBonusCopies(card.key)

		if (target <= 0) {
			return card
		}
	}

	return eligibleCards.at(-1) || null
}

const maybeInjectDebtBonusOffer = deck => {
	if (state.savings >= 0 || Math.random() >= 0.75) {
		return deck
	}

	const bonusCard = pickDebtBonusOffer()

	if (!bonusCard || deck.length === 0) {
		return deck
	}

	const replaceIndex = Math.floor(Math.random() * deck.length)
	const replacedCard = deck[replaceIndex]
	const nextDeck = [...deck]
	nextDeck[replaceIndex] = {
		id: replacedCard.id,
		bonusCard
	}

	return nextDeck
}

const stageLabel = stage => {
	if (stage === 1) {
		return '1st'
	}

	if (stage === 2) {
		return '2nd'
	}

	if (stage === 3) {
		return '3rd'
	}

	return `Stage ${stage}`
}

const buyRoundTitle = stage => `${stageLabel(stage)} buy round`

const sellRoundTitle = stage => (stage === TOTAL_BUY_STAGES ? 'Final sell round' : `${stageLabel(stage)} sell round`)
const bonusRoundTitle = () => 'Bonus Cards'

const deckSliceLabel = stage => {
	if (stage === 1) {
		return 'first 1/3 of the deck'
	}

	if (stage === 2) {
		return 'second third of the deck'
	}

	if (stage === 3) {
		return 'final third of the deck'
	}

	return `deck segment ${stage}`
}

const currentStageStart = () => (state.buyStage - 1) * BUY_STAGE_SIZE
const canAffordRemainingStageCards = () => {
	for (const card of state.queue) {
		if (state.cash >= buyPriceForCard(card)) {
			return true
		}
	}

	const stageLimit = Math.min(currentStageLimit(), state.deck.length)

	for (let index = state.dealCursor; index < stageLimit; index += 1) {
		if (state.cash >= buyPriceForCard(state.deck[index])) {
			return true
		}
	}

	return false
}

const cardsSeenInStage = () => Math.max(0, state.dealCursor - currentStageStart())

const buildRoundDeck = () => maybeInjectDebtBonusOffer(buildDeck({ cardTypes: CARD_TYPES, heatValues: HEAT_VALUES }))

const highestRankForType = typeKey => highestRankInHand({ hand: state.hand, typeKey })

const currentSellValueForCard = card => {
	const activeRank = state.sellPhaseRanks.get(card.type.key) || highestRankForType(card.type.key)
	const sellRanks = new Map([[card.type.key, activeRank]])

	return sellValueForCard({ card, sellPhaseRanks: sellRanks })
}

const currentCreditDeltaForProfit = profit => creditDeltaForProfit({ profit, roundStartCredit: state.roundStartCredit })

const currentPerformanceLabel = profit => performanceLabel({ profit, roundStartCredit: state.roundStartCredit })

const heatOpacityFor = heat => {
	if (heat >= 75) {
		return 1
	}

	if (heat <= 15) {
		return 0.4
	}

	return 0.4 + ((heat - 15) / 60) * 0.6
}

const getTypeImageAsset = type => {
	const image = state.images.get(type.key)

	if (!image || !TINTED_TYPE_IMAGE_KEYS.has(type.key)) {
		return image
	}

	const cacheKey = `${type.key}:${type.accent}`
	const cachedImage = tintedTypeImages.get(cacheKey)

	if (cachedImage) {
		return cachedImage
	}

	const tintCanvas = document.createElement('canvas')
	tintCanvas.width = image.naturalWidth || image.width
	tintCanvas.height = image.naturalHeight || image.height
	const tintContext = tintCanvas.getContext('2d')

	if (!tintContext) {
		return image
	}

	tintContext.drawImage(image, 0, 0)
	tintContext.globalCompositeOperation = 'source-in'
	tintContext.fillStyle = type.accent
	tintContext.fillRect(0, 0, tintCanvas.width, tintCanvas.height)
	tintedTypeImages.set(cacheKey, tintCanvas)

	return tintCanvas
}

const drawTypeImage = (type, x, y, size) => {
	const image = getTypeImageAsset(type)

	if (image) {
		ctx.drawImage(image, x, y, size, size)
		return
	}

	ctx.fillStyle = THEME.panelSoft
	ctx.fillRect(x, y, size, size)
	ctx.fillStyle = type.accent
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.font = `700 ${Math.max(12, size * 0.45)}px ${mainFont}`
	ctx.fillText(type.singular[0], x + size / 2, y + size / 2)
}

const drawHeatBadge = (card, x, y, size) => {
	const fireImage = state.images.get('fire')
	const compactCard = size < 76
	const opacity = heatOpacityFor(card.heat)
	const iconSize = compactCard ? Math.max(10, size * 0.12) : Math.max(14, size * 0.14)
	const inset = compactCard ? Math.max(6, size * 0.07) : Math.max(10, size * 0.09)
	const fontSize = compactCard ? Math.max(9, size * 0.11) : Math.max(13, size * 0.13)
	const badgeY = y + inset + iconSize / 2
	const heatLabel = String(card.heat)
	const numberRight = x + size - inset
	const iconGap = compactCard ? 3 : 5

	ctx.save()
	ctx.globalAlpha = opacity
	ctx.fillStyle = THEME.heat
	ctx.textAlign = 'right'
	ctx.textBaseline = 'alphabetic'
	ctx.font = `700 ${fontSize}px ${mainFont}`
	const numberMetrics = ctx.measureText(heatLabel)
	const numberWidth = numberMetrics.width
	const ascent = numberMetrics.actualBoundingBoxAscent || fontSize * 0.72
	const descent = numberMetrics.actualBoundingBoxDescent || fontSize * 0.18
	const numberBaselineY = badgeY + (ascent - descent) / 2
	ctx.fillText(heatLabel, numberRight, numberBaselineY)
	const iconX = numberRight - numberWidth - iconGap - iconSize

	if (fireImage) {
		ctx.drawImage(fireImage, iconX, badgeY - iconSize / 2, iconSize, iconSize)
	} else {
		ctx.fillStyle = THEME.heatSoft
		ctx.beginPath()
		ctx.arc(iconX + iconSize / 2, badgeY, iconSize * 0.3, 0, Math.PI * 2)
		ctx.fill()
	}
	ctx.restore()
}

const centeredSectionTop = contentHeight => {
	const topPadding = clamp(state.height * 0.06, 40, 76)
	const bottomLimit = state.height - state.footerHeight - clamp(state.height * 0.05, 28, 44)
	const availableHeight = Math.max(0, bottomLimit - topPadding)
	const maxTop = Math.max(topPadding, bottomLimit - contentHeight)
	const centeredTop = topPadding + Math.max(0, (availableHeight - contentHeight) / 2)
	const downwardBias = clamp(state.height * 0.08, 36, 88)

	return Math.min(maxTop, Math.max(topPadding, centeredTop + downwardBias))
}

const easeOutCubic = progress => 1 - (1 - progress) ** 3

const cardHeightFor = size => Math.round(size * CARD_HEIGHT_RATIO)

const roundCashDisplay = value => Math.round(value / 50) * 50

const syncCashDisplay = value => {
	state.cash = value
	state.displayedCash = value
	state.cashTicker = null
}

const setCashValue = (value, animate = true) => {
	const nextValue = Math.max(0, value)
	state.cash = nextValue

	if (!animate) {
		state.displayedCash = nextValue
		state.cashTicker = null
		return
	}

	if (Math.abs(nextValue - state.displayedCash) < 1) {
		state.displayedCash = nextValue
		state.cashTicker = null
		return
	}

	state.cashTicker = {
		from: state.displayedCash,
		target: nextValue,
		elapsed: 0,
		duration: CASH_TICKER_DURATION_MS
	}
	startAnimationLoop()
}

const getFastFlipProgress = progress => clamp(progress / FLIP_PORTION, 0, 1)

const getMotionProgress = motion => clamp(motion.elapsed / motion.duration, 0, 1)

const getMotionPosition = motion => {
	const progress = getMotionProgress(motion)
	const eased = easeOutCubic(progress)

	return {
		x: motion.fromX + (motion.targetX - motion.fromX) * eased,
		y: motion.fromY + (motion.targetY - motion.fromY) * eased,
		size: motion.fromSize + (motion.targetSize - motion.fromSize) * eased,
		progress
	}
}

const resetCardMotion = () => {
	state.cardMotions.clear()
	state.queueRenderSlots.clear()
	state.handRenderSlots.clear()
	state.openingDealOrder.clear()
	state.deckRect = null

	if (state.cashTicker || state.sellHeatCheck) {
		return
	}

	state.lastAnimationTime = 0

	if (state.animationFrameId !== null) {
		cancelAnimationFrame(state.animationFrameId)
		state.animationFrameId = null
	}
}

	
const startAnimationLoop = () => {
	if (state.animationFrameId === null) {
		state.animationFrameId = requestAnimationFrame(animateQueueFrame)
	}
}

const updateCardMotion = deltaMs => {
	let hasActiveMotion = false
	const finishedIds = []

	state.cardMotions.forEach((motion, cardId) => {
		if (motion.delayMs > 0) {
			motion.delayMs = Math.max(0, motion.delayMs - deltaMs)

			if (motion.delayMs > 0) {
				hasActiveMotion = true
				return
			}
		}

		motion.elapsed = Math.min(motion.duration, motion.elapsed + deltaMs)

		if (motion.elapsed < motion.duration) {
			hasActiveMotion = true
			return
		}

		finishedIds.push(cardId)
	})

	finishedIds.forEach(cardId => {
		state.cardMotions.delete(cardId)
	})

	return hasActiveMotion
}

const updateCashTicker = deltaMs => {
	if (!state.cashTicker) {
		return false
	}

	state.cashTicker.elapsed = Math.min(state.cashTicker.duration, state.cashTicker.elapsed + deltaMs)

	const progress = getMotionProgress(state.cashTicker)
	const difference = state.cashTicker.target - state.cashTicker.from
	const swing = Math.max(CASH_TICKER_MIN_SWING, Math.abs(difference) * 0.18)
	const wobble = -Math.sin(progress * Math.PI * 2 * CASH_TICKER_CYCLES) * swing * (1 - progress) ** 1.15
	const nextValue = state.cashTicker.from + difference * progress + wobble

	state.displayedCash = Math.max(0, roundCashDisplay(nextValue))

	if (progress >= 1) {
		state.displayedCash = state.cashTicker.target
		state.cashTicker = null
		return false
	}

	return true
}

const createHeatReel = (targetDigit, index) => {
	const startDigit = Math.floor(Math.random() * 10)
	const extraLoops = 14 + index * 2 + Math.floor(Math.random() * 3)
	const forwardSteps = (targetDigit - startDigit + 10) % 10
	const targetPosition = startDigit + extraLoops * 10 + forwardSteps

	return {
		stage: 'rolling',
		startDigit,
		targetDigit,
		position: startDigit,
		targetPosition,
		elapsed: 0,
		spinDuration: SELL_HEAT_ROLL_MS - (1 - index) * SELL_HEAT_REEL_STAGGER_MS,
		overshootPosition: targetPosition + 0.16
	}
}

const updateHeatReel = (reel, deltaMs) => {
	if (reel.stage === 'stopped') {
		return reel
	}

	const nextReel = { ...reel, elapsed: reel.elapsed + deltaMs }

	if (reel.stage === 'rolling') {
		const progress = clamp(nextReel.elapsed / nextReel.spinDuration, 0, 1)
		nextReel.position = reel.startDigit + (reel.targetPosition - reel.startDigit) * easeOutCubic(progress)

		if (progress >= 1) {
			nextReel.stage = 'overshoot'
			nextReel.elapsed = 0
			nextReel.position = reel.targetPosition
		}

		return nextReel
	}

	if (reel.stage === 'overshoot') {
		const progress = clamp(nextReel.elapsed / SELL_HEAT_REEL_OVERSHOOT_MS, 0, 1)
		nextReel.position = reel.targetPosition + (reel.overshootPosition - reel.targetPosition) * easeOutCubic(progress)

		if (progress >= 1) {
			nextReel.stage = 'settling'
			nextReel.elapsed = 0
			nextReel.position = reel.overshootPosition
		}

		return nextReel
	}

	const progress = clamp(nextReel.elapsed / SELL_HEAT_REEL_SETTLE_MS, 0, 1)
	nextReel.position = reel.overshootPosition + (reel.targetPosition - reel.overshootPosition) * easeOutCubic(progress)

	if (progress >= 1) {
		nextReel.stage = 'stopped'
		nextReel.elapsed = 0
		nextReel.position = reel.targetPosition
	}

	return nextReel
}

const sellHeatOutcomeLabel = sellHeatCheck => {
	if (!sellHeatCheck || sellHeatCheck.stage === 'rolling') {
		return 'roll high to dodge the police...'
	}

	if (sellHeatCheck.stage === 'landed' && sellHeatCheck.elapsed < SELL_HEAT_RESULT_HOLD_MS) {
		return `rolled ${String(sellHeatCheck.result).padStart(2, '0')}%`
	}

	const confiscatedCount = sellHeatCheck.confiscatedIds.length

	if (confiscatedCount === 0) {
		return 'safe!'
	}

	if (confiscatedCount >= sellHeatCheck.startingHandSize) {
		return 'all your items were confiscated'
	}

	return confiscatedCount === 1 ? '1 of your items was confiscated' : `${confiscatedCount} of your items were confiscated`
}

const finalizeSellHeatCheck = () => {
	if (!state.sellHeatCheck) {
		return
	}

	const handSizeBeforeConfiscation = state.hand.length
	const confiscatedIds = new Set(state.sellHeatCheck.confiscatedIds)

	if (confiscatedIds.size > 0) {
		state.hand = state.hand.filter(card => !confiscatedIds.has(card.id))
	}

	if (handSizeBeforeConfiscation > 0 && confiscatedIds.size === handSizeBeforeConfiscation) {
		setNotice('all your items were confiscated')
	}

	state.bribePrompt = null
	state.sellHeatCheck = null
	lockSellPhaseRanks()
}

const updateSellHeatCheck = deltaMs => {
	if (!state.sellHeatCheck) {
		return false
	}

	if (state.sellHeatCheck.stage === 'rolling') {
		state.sellHeatCheck = {
			...state.sellHeatCheck,
			reels: state.sellHeatCheck.reels.map(reel => updateHeatReel(reel, deltaMs))
		}

		if (state.sellHeatCheck.reels.every(reel => reel.stage === 'stopped')) {
			state.sellHeatCheck = {
				...state.sellHeatCheck,
				stage: 'landed',
				elapsed: 0
			}
		}

		return true
	}

	state.sellHeatCheck.elapsed += deltaMs

	if (state.sellHeatCheck.stage === 'landed') {
		if (state.sellHeatCheck.elapsed < SELL_HEAT_LAND_MS) {
			return true
		}

		if (state.sellHeatCheck.confiscatedIds.length === 0) {
			finalizeSellHeatCheck()
			return false
		}

		if (state.bribesRemaining > 0) {
			state.bribePrompt = {
				confiscatedCount: state.sellHeatCheck.confiscatedIds.length,
				result: state.sellHeatCheck.result
			}
			state.sellHeatCheck = {
				...state.sellHeatCheck,
				stage: 'prompt',
				elapsed: 0
			}
			return false
		}

		state.sellHeatCheck = {
			...state.sellHeatCheck,
			stage: 'flash',
			elapsed: 0
		}

		return true
	}

	if (state.sellHeatCheck.stage === 'prompt') {
		return false
	}

	if (state.sellHeatCheck.stage === 'flash') {
		if (state.sellHeatCheck.elapsed < SELL_HEAT_FLASH_MS) {
			return true
		}

		finalizeSellHeatCheck()
		return false
	}

	finalizeSellHeatCheck()
	return false
}

const applySellRoundTransition = transition => {
	state.sellRoundTransition = null

	if (transition.nextPhase === 'summary') {
		openBonusShop(transition.nextPhase)
		return
	}

	resetCardMotion()
	state.buyStage += 1
	state.phase = `buy-${state.buyStage}`
	state.queue = []
	state.sellPhaseRanks.clear()
	state.sellHeatCheck = null
	refillQueue()
	setNotice(`${buyRoundTitle(state.buyStage)}. ${deckSliceLabel(state.buyStage)} is on the table.`)
}

const applyBuySkipTransition = transition => {
	state.buySkipTransition = null
	advanceToSellPhase(transition.message)
}

const updateSellRoundTransition = deltaMs => {
	if (!state.sellRoundTransition) {
		return false
	}

	state.sellRoundTransition.elapsed += deltaMs

	if (state.sellRoundTransition.elapsed < state.sellRoundTransition.duration) {
		return true
	}

	applySellRoundTransition(state.sellRoundTransition)
	return false
}

const updateBuySkipTransition = deltaMs => {
	if (!state.buySkipTransition) {
		return false
	}

	state.buySkipTransition.elapsed += deltaMs

	if (state.buySkipTransition.elapsed < state.buySkipTransition.duration) {
		return true
	}

	applyBuySkipTransition(state.buySkipTransition)
	return false
}

const animateQueueFrame = timestamp => {
	state.animationFrameId = null

	const deltaMs = state.lastAnimationTime ? Math.min(timestamp - state.lastAnimationTime, 34) : 16
	state.lastAnimationTime = timestamp

	const hasActiveCardMotion = updateCardMotion(deltaMs)
	const hasActiveCashTicker = updateCashTicker(deltaMs)
	const hasActiveSellHeatCheck = updateSellHeatCheck(deltaMs)
	const hasActiveSellRoundTransition = updateSellRoundTransition(deltaMs)
	const hasActiveBuySkipTransition = updateBuySkipTransition(deltaMs)

	if (hasActiveCardMotion || hasActiveCashTicker || hasActiveSellHeatCheck || hasActiveSellRoundTransition || hasActiveBuySkipTransition) {
		render()

		if (state.animationFrameId === null) {
			state.animationFrameId = requestAnimationFrame(animateQueueFrame)
		}

		return
	}

	state.lastAnimationTime = 0
	render()
}

const ensureDeckToQueueMotion = (cardId, deckRect, targetX, targetY, size) => {
	let motion = state.cardMotions.get(cardId)

	if (!motion) {
		const openingIndex = state.openingDealOrder.get(cardId)
		const delayMs = openingIndex === undefined ? 0 : openingIndex * OPENING_DEAL_STAGGER_MS

		motion = {
			kind: 'from-deck',
			fromX: deckRect.x,
			fromY: deckRect.y,
			fromSize: deckRect.size,
			targetX,
			targetY,
			targetSize: size,
			delayMs,
			elapsed: 0,
			duration: QUEUE_ANIMATION_MS
		}
		state.cardMotions.set(cardId, motion)
		startAnimationLoop()
		return motion
	}

	if (motion.kind !== 'from-deck') {
		return motion
	}

	motion.targetX = targetX
	motion.targetY = targetY
	motion.targetSize = size
	return motion
}

const ensureQueueShiftMotion = (cardId, previousSlot, targetX, targetY, size) => {
	const motion = state.cardMotions.get(cardId)

	if (motion?.kind === 'from-deck') {
		motion.targetX = targetX
		motion.targetY = targetY
		motion.targetSize = size
		return motion
	}

	if (motion?.kind === 'queue-shift') {
		motion.targetX = targetX
		motion.targetY = targetY
		motion.targetSize = size
		return motion
	}

	if (!previousSlot) {
		return null
	}

	if (
		Math.abs(previousSlot.x - targetX) < 0.5 &&
		Math.abs(previousSlot.y - targetY) < 0.5 &&
		Math.abs(previousSlot.size - size) < 0.5
	) {
		return null
	}

	const nextMotion = {
		kind: 'queue-shift',
		fromX: previousSlot.x,
		fromY: previousSlot.y,
		fromSize: previousSlot.size,
		targetX,
		targetY,
		targetSize: size,
		delayMs: 0,
		elapsed: 0,
		duration: Math.round(QUEUE_ANIMATION_MS * 0.82)
	}

	state.cardMotions.set(cardId, nextMotion)
	startAnimationLoop()
	return nextMotion
}

const ensureHandShiftMotion = (cardId, previousSlot, targetX, targetY, size) => {
	const motion = state.cardMotions.get(cardId)

	if (motion?.kind === 'to-hand' || motion?.kind === 'hand-shift') {
		motion.targetX = targetX
		motion.targetY = targetY
		motion.targetSize = size
		return motion
	}

	if (!previousSlot) {
		return null
	}

	if (
		Math.abs(previousSlot.x - targetX) < 0.5 &&
		Math.abs(previousSlot.y - targetY) < 0.5 &&
		Math.abs(previousSlot.size - size) < 0.5
	) {
		return null
	}

	const nextMotion = {
		kind: 'hand-shift',
		fromX: previousSlot.x,
		fromY: previousSlot.y,
		fromSize: previousSlot.size,
		targetX,
		targetY,
		targetSize: size,
		delayMs: 0,
		elapsed: 0,
		duration: Math.round(HAND_ANIMATION_MS * 0.82)
	}

	state.cardMotions.set(cardId, nextMotion)
	startAnimationLoop()
	return nextMotion
}

const startHandMotion = (cardId, fromSlot) => {
	if (!fromSlot) {
		return
	}

	state.cardMotions.set(cardId, {
		kind: 'to-hand',
		fromX: fromSlot.x,
		fromY: fromSlot.y,
		fromSize: fromSlot.size,
		targetX: fromSlot.x,
		targetY: fromSlot.y,
		targetSize: fromSlot.size,
		delayMs: 0,
		elapsed: 0,
		duration: HAND_ANIMATION_MS
	})
	startAnimationLoop()
}

const pruneCardMotion = () => {
	const activeCardIds = new Set([...state.queue, ...state.hand].map(card => card.id))

	state.cardMotions.forEach((motion, cardId) => {
		if (!activeCardIds.has(cardId)) {
			state.cardMotions.delete(cardId)
		}
	})
}

const roundedRectPath = (x, y, width, height) => {
	ctx.beginPath()
	ctx.rect(x, y, width, height)
	ctx.closePath()
}

const fillRoundedRect = (x, y, width, height, radius, fillStyle) => {
	roundedRectPath(x, y, width, height)
	ctx.fillStyle = fillStyle
	ctx.fill()
}

const wrapTextLines = (text, maxWidth) => {
	const words = text.split(' ')
	const lines = []
	let current = ''

	words.forEach(word => {
		const candidate = current ? `${current} ${word}` : word

		if (ctx.measureText(candidate).width <= maxWidth || !current) {
			current = candidate
			return
		}

		lines.push(current)
		current = word
	})

	if (current) {
		lines.push(current)
	}

	return lines
}

const drawWrappedText = (text, x, y, maxWidth, lineHeight, fillStyle = '#231b16') => {
	const lines = wrapTextLines(text, maxWidth)

	ctx.fillStyle = fillStyle
	lines.forEach((line, index) => {
		ctx.fillText(line, x, y + index * lineHeight)
	})

	return lines.length * lineHeight
}

const parseInlineTextTokens = text => {
	const parts = text.split(/(<[a-z-]+ icon>)/g).filter(Boolean)
	const tokens = []

	parts.forEach(part => {
		const iconMatch = part.match(/^<([a-z-]+) icon>$/)

		if (iconMatch) {
			tokens.push({ type: 'icon', key: iconMatch[1] })
			return
		}

		part
			.split(/\s+/)
			.filter(Boolean)
			.forEach(word => {
				tokens.push({ type: 'text', value: word })
			})
	})

	return tokens
}

const drawWrappedInlineText = (text, x, y, maxWidth, lineHeight, fillStyle = '#231b16') => {
	const tokens = parseInlineTextTokens(text)
	const spaceWidth = ctx.measureText(' ').width
	const iconSize = Math.max(14, Math.round(lineHeight * 0.82))
	const iconOffsetY = Math.round(iconSize * 0.78)
	let cursorX = x
	let lineIndex = 0
	let isLineStart = true

	ctx.fillStyle = fillStyle

	const moveToNextLine = () => {
		lineIndex += 1
		cursorX = x
		isLineStart = true
	}

	tokens.forEach(token => {
		const tokenWidth = token.type === 'icon' ? iconSize : ctx.measureText(token.value).width
		const nextX = isLineStart ? cursorX : cursorX + spaceWidth

		if (!isLineStart && nextX + tokenWidth > x + maxWidth) {
			moveToNextLine()
		}

		if (!isLineStart) {
			cursorX += spaceWidth
		}

		const baselineY = y + lineIndex * lineHeight

		if (token.type === 'icon') {
			const image = state.images.get(token.key)

			if (image) {
				ctx.drawImage(image, cursorX, baselineY - iconOffsetY, iconSize, iconSize)
			} else {
				ctx.fillText(token.key, cursorX, baselineY)
			}
		} else {
			ctx.fillText(token.value, cursorX, baselineY)
		}

		cursorX += tokenWidth
		isLineStart = false
	})

	return (lineIndex + 1) * lineHeight
}

const setNotice = text => {
	state.notice = text
}

const currentStageLimit = () => state.buyStage * BUY_STAGE_SIZE

const loadCardImages = async () => {
	await Promise.all(
		[
			...CARD_TYPES,
			...BONUS_CARDS.map(card => ({ key: card.imageKey, imagePath: card.imagePath })),
			{ key: 'question-mark', imagePath: 'assets/question-mark.png' },
			{ key: 'fire', imagePath: 'assets/fire.png' },
			{ key: 'bribe-icon', imagePath: 'assets/bribe-icon.png' },
			{ key: 'jewel-icon', imagePath: 'assets/cards/jewel.png' }
		].map(
			type =>
				new Promise(resolve => {
					const image = new Image()
					image.onload = () => {
						state.images.set(type.key, image)
						resolve()
					}
					image.onerror = () => {
						state.images.set(type.key, null)
						resolve()
					}
					image.src = type.imagePath
				})
		)
	)
}

const refillQueue = () => {
	while (state.queue.length < currentBuyQueueCapacity() && state.dealCursor < currentStageLimit() && state.dealCursor < state.deck.length) {
		state.queue.push(state.deck[state.dealCursor])
		state.dealCursor += 1
	}
}

const openBonusShop = nextPhase => {
	if (nextPhase === 'summary' && !state.roundResult) {
		finalizeRound()
	}

	if (!anyBonusCopiesRemaining()) {
		transitionFromBonusPhase(nextPhase)
		return
	}

	resetCardMotion()
	state.sellHeatCheck = null
	state.bribePrompt = null
	state.pendingBonusPhase = nextPhase
	state.phase = `bonus-${state.buyStage}`
	state.showHowToPlay = false
	setNotice('Review the bonus cards. Buy any you want, or continue.')
}

const transitionFromBonusPhase = nextPhase => {
	if (nextPhase === 'buy') {
		resetCardMotion()
		state.buyStage += 1
		state.phase = `buy-${state.buyStage}`
		state.queue = []
		state.sellPhaseRanks.clear()
		state.sellHeatCheck = null
		state.bribePrompt = null
		refillQueue()
		setNotice(`${buyRoundTitle(state.buyStage)}. ${deckSliceLabel(state.buyStage)} is on the table.`)
		return
	}

	state.phase = 'summary'
}

const continueFromBonusShop = () => {
	const nextPhase = state.pendingBonusPhase
	state.pendingBonusPhase = null
	transitionFromBonusPhase(nextPhase)
}

const startRound = () => {
	resetCardMotion()
	state.phase = 'buy-1'
	state.roundStartCredit = state.creditLimit
	syncCashDisplay(state.creditLimit)
	state.deck = buildRoundDeck()
	state.dealCursor = 0
	state.queue = []
	state.hand = []
	state.sellPhaseRanks.clear()
	state.showHowToPlay = false
	state.buyStage = 1
	state.pendingBonusPhase = null
	state.bribePrompt = null
	state.bribesRemaining = bonusOwnedCount('bribes')
	state.roundResult = null
	setNotice(`Pick your first ${currentBuyQueueCapacity()} offers. You can carry up to ${currentMaxHandSize()} cards across the full week.`)
	refillQueue()
	state.queue.forEach((card, index) => {
		state.openingDealOrder.set(card.id, index)
	})
}
const lockSellPhaseRanks = () => {
	state.sellPhaseRanks.clear()

	CARD_TYPES.forEach(type => {
		state.sellPhaseRanks.set(type.key, highestRankForType(type.key))
	})
}

const startSellHeatCheck = () => {
	state.queueRenderSlots.clear()
	state.openingDealOrder.clear()
	state.deckRect = null
	state.bribePrompt = null
	const result = Math.floor(Math.random() * 100)
	const confiscatedIds = state.hand.filter(card => result < card.heat).map(card => card.id)
	state.sellHeatCheck = {
		stage: 'rolling',
		elapsed: 0,
		result,
		confiscatedIds,
		startingHandSize: state.hand.length,
		reels: [createHeatReel(Math.floor(result / 10), 0), createHeatReel(result % 10, 1)]
	}
	startAnimationLoop()
}

const spendBribeOnHeatRoll = () => {
	if (!state.sellHeatCheck || state.sellHeatCheck.stage !== 'prompt' || state.bribesRemaining <= 0) {
		return
	}

	state.bribesRemaining -= 1
	state.bribePrompt = null
	state.sellHeatCheck = null
	setNotice('Spent a bribe for a reroll.')
	startSellHeatCheck()
}

const declineBribeOnHeatRoll = () => {
	if (!state.sellHeatCheck || state.sellHeatCheck.stage !== 'prompt') {
		return
	}

	state.bribePrompt = null
	state.sellHeatCheck = {
		...state.sellHeatCheck,
		stage: 'flash',
		elapsed: 0
	}
	startAnimationLoop()
}

const buyBonusCard = bonusKey => {
	const bonusCard = BONUS_CARD_LOOKUP.get(bonusKey)

	if (!bonusCard) {
		return
	}

	if (remainingBonusCopies(bonusKey) === 0) {
		setNotice(`${bonusCard.name} is sold out.`)
		return
	}

	if (state.savings < bonusCard.cost) {
		setNotice(`You need ${formatMoney(bonusCard.cost)} in savings to buy ${bonusCard.name.toLowerCase()}.`)
		return
	}

	state.savings -= bonusCard.cost
	grantBonusOwnership(bonusKey)

	setNotice(`Bought ${bonusCard.name} for ${formatMoney(bonusCard.cost)}.`)
}
const removeCardFromCollection = (collection, cardId) => {
	const index = collection.findIndex(card => card.id === cardId)

	if (index === -1) {
		return null
	}

	return collection.splice(index, 1)[0]
}
const advanceToSellPhase = notice => {
	state.phase = `sell-${state.buyStage}`
	setNotice(notice)

	if (state.hand.length === 0) {
		state.sellHeatCheck = null
		lockSellPhaseRanks()
		return
	}

	startSellHeatCheck()
}

const maybeAdvanceFromBuyPhase = () => {
	refillQueue()

	if (state.queue.length === 0 && state.dealCursor >= currentStageLimit()) {
		advanceToSellPhase(
			state.buyStage < TOTAL_BUY_STAGES
				? `${sellRoundTitle(state.buyStage)}. Sell any cards you want, or keep them for ${deckSliceLabel(state.buyStage + 1)}.`
				: 'Final sell round. Anything left in your hand when the week closes is sold automatically.'
		)
		return
	}

	if (canAffordRemainingStageCards()) {
		return
	}

	if (cardsSeenInStage() >= BUY_STAGE_SIZE / 2) {
		return
	}

	if (state.buyStage === TOTAL_BUY_STAGES) {
		advanceToSellPhase('Final sell round. Anything left in your hand when the week closes is sold automatically.')
		return
	}

	state.buySkipTransition = {
		elapsed: 0,
		duration: BUY_SKIP_NOTICE_MS,
		message:
			state.buyStage < TOTAL_BUY_STAGES
				? `${sellRoundTitle(state.buyStage)}. You can't afford any more offers, so the rest of this buy round is skipped.`
				: ''
	}
	startAnimationLoop()
}

const buyCard = cardId => {
	const card = state.queue.find(entry => entry.id === cardId)
	const fromSlot = state.queueRenderSlots.get(cardId)

	if (!card) {
		return
	}

	if (!isDebtBonusOffer(card) && state.hand.length >= currentMaxHandSize()) {
		setNotice(`Your hand is full. You can hold up to ${currentMaxHandSize()} cards.`)
		return
	}

	const buyPrice = buyPriceForCard(card)

	if (state.cash < buyPrice) {
		setNotice(
			isDebtBonusOffer(card)
				? `You need ${formatMoney(buyPrice)} to buy ${card.bonusCard.name.toLowerCase()}.`
				: `You need ${formatMoney(buyPrice)} to buy that ${card.type.singular.toLowerCase()}.`
		)
		return
	}

	setCashValue(state.cash - buyPrice)
	const boughtCard = removeCardFromCollection(state.queue, cardId)

	if (!boughtCard) {
		return
	}

	if (isDebtBonusOffer(boughtCard)) {
		grantBonusOwnership(boughtCard.bonusCard.key)
		setNotice(`Bought ${boughtCard.bonusCard.name} for ${formatMoney(buyPrice)}.`)
		maybeAdvanceFromBuyPhase()
		return
	}

	boughtCard.purchasePrice = buyPrice
	state.hand.push(boughtCard)
	startHandMotion(cardId, fromSlot)
	setNotice(`Bought ${card.type.singular.toLowerCase()} ${card.rank} for ${formatMoney(buyPrice)}.`)
	maybeAdvanceFromBuyPhase()
}

const rejectCard = cardId => {
	const card = removeCardFromCollection(state.queue, cardId)

	if (!card) {
		return
	}

	setNotice(isDebtBonusOffer(card) ? `Rejected ${card.bonusCard.name.toLowerCase()}.` : `Rejected ${card.type.singular.toLowerCase()} ${card.rank}.`)
	maybeAdvanceFromBuyPhase()
}

const sellCard = cardId => {
	const card = state.hand.find(entry => entry.id === cardId)

	if (!card) {
		return
	}

	const proceeds = currentSellValueForCard(card)
	setCashValue(state.cash + proceeds)
	removeCardFromCollection(state.hand, cardId)
	setNotice(`Sold ${card.type.singular.toLowerCase()} ${card.rank} for ${formatMoney(proceeds)}.`)
}

const sellAllCards = () => {
	if (state.hand.length === 0) {
		setNotice('There is nothing in your hand to sell.')
		return
	}

	const cardsToSell = [...state.hand]
	const proceeds = cardsToSell.reduce((total, card) => total + currentSellValueForCard(card), 0)

	state.hand = []
	setCashValue(state.cash + proceeds)
	setNotice(`Sold your full hand for ${formatMoney(proceeds)}.`)
}

const savingsLabel = () => (state.savings < 0 ? 'Debt' : 'Savings')
const savingsDisplayValue = () => (state.savings < 0 ? `-${formatMoney(Math.abs(state.savings))}` : formatMoney(state.savings))

const finalizeRound = () => {
	resetCardMotion()
	const autoSellProceeds = state.hand.reduce((total, card) => total + currentSellValueForCard(card), 0)
	const cashOut = state.cash + autoSellProceeds
	const profit = cashOut - state.roundStartCredit
	const unsoldCards = 0
	const previousCredit = state.creditLimit
	const creditDelta = currentCreditDeltaForProfit(profit)
	const nextCredit = clamp(previousCredit + creditDelta, CREDIT_FLOOR, CREDIT_CEILING)
	const actualCreditChange = nextCredit - previousCredit

	syncCashDisplay(cashOut)
	state.savings += profit
	state.creditLimit = nextCredit
	state.roundResult = {
		cashOut,
		profit,
		unsoldCards,
		creditDelta,
		actualCreditChange,
		nextCredit,
		summary: currentPerformanceLabel(profit)
	}
	state.hand = []
	state.queue = []
	state.sellPhaseRanks.clear()
	state.sellHeatCheck = null
	state.sellRoundTransition = null
	state.showHowToPlay = false
	state.phase = 'summary'
	setNotice(`Week closed with ${formatMoney(cashOut)} banked.`)
}

const endSellPhase = () => {
	const weeklyOverhead = currentWeeklyOverhead()
	const overheadPaid = weeklyOverhead > 0 ? Math.min(state.cash, weeklyOverhead) : 0
	const legitimateIncome = weeklyOverhead < 0 ? -weeklyOverhead : 0
	setCashValue(state.cash - overheadPaid + legitimateIncome)
	state.sellRoundTransition = {
		elapsed: 0,
		duration: SELL_ROUND_OVERHEAD_NOTICE_MS,
		overheadPaid,
		legitimateIncome,
		nextPhase: state.buyStage < TOTAL_BUY_STAGES ? 'buy' : 'summary',
		message:
			legitimateIncome > 0
				? `Earned ${formatMoney(legitimateIncome)} in legitimate income.`
				: `Paid ${formatMoney(overheadPaid)} in overhead.`
	}
	startAnimationLoop()
}

const nextRound = () => {
	state.roundNumber += 1
	startRound()
}

const registerButton = button => {
	state.buttons.push(button)

	const isHovered = state.hoveredButtonId === button.id && button.enabled !== false
	const palette = {
		buy: {
			fill: isHovered ? '#429485' : THEME.buttonBuy,
			text: THEME.text
		},
		reject: {
			fill: isHovered ? '#7b5246' : THEME.buttonReject,
			text: THEME.text
		},
		sell: {
			fill: isHovered ? '#94722d' : THEME.buttonSell,
			text: THEME.text
		},
		primary: {
			fill: isHovered ? '#429485' : THEME.buttonPrimary,
			text: THEME.text
		},
		muted: {
			fill: isHovered ? '#363e47' : THEME.panelMuted,
			text: THEME.text
		}
	}
	const style = palette[button.tone || 'muted']
	const fill = button.enabled === false ? THEME.buttonDisabled : style.fill
	const textColor = button.enabled === false ? THEME.buttonTextDisabled : style.text
	const labelLines = button.label.split('\n')
	const maxLabelWidth = Math.max(0, button.width - 14)
	const emphasisScale = button.tone === 'buy' || button.tone === 'reject' ? 1.35 : 1
	let fontSize = Math.max(10, button.height * (labelLines.length > 1 ? 0.24 : 0.38) * emphasisScale)

	ctx.font = `600 ${fontSize}px ${mainFont}`

	while (fontSize > 10 && labelLines.some(line => ctx.measureText(line).width > maxLabelWidth)) {
		fontSize -= 1
		ctx.font = `600 ${fontSize}px ${mainFont}`
	}

	fillRoundedRect(button.x, button.y, button.width, button.height, 10, fill)
	ctx.fillStyle = textColor
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	const hoverIcon = button.hoverIconKey ? state.images.get(button.hoverIconKey) : null
	const showHoverIcon = isHovered && hoverIcon

	if (labelLines.length === 1) {
		const textCenterX = button.x + button.width / 2
		const textCenterY = button.y + button.height / 2 + 0.5
		ctx.fillText(button.label, textCenterX, textCenterY)

		if (button.hoverIconKey && hoverIcon) {
			const iconSize = Math.max(22, Math.min(button.height - 6, Math.round((fontSize + 2) * 1.8)))
			const iconGap = Math.max(8, Math.round(iconSize * 0.4))
			const labelWidth = ctx.measureText(button.label).width
			const labelLeft = textCenterX - labelWidth / 2
			const iconX = labelLeft - iconGap - iconSize
			const iconY = button.y + (button.height - iconSize) / 2

			ctx.save()
			ctx.globalAlpha = showHoverIcon ? 1 : 0
			ctx.drawImage(hoverIcon, iconX, iconY, iconSize, iconSize)
			ctx.restore()
		}

		return
	}

	const lineHeight = fontSize + 2
	const labelBlockHeight = lineHeight * labelLines.length
	const firstLineY = button.y + (button.height - labelBlockHeight) / 2 + lineHeight / 2 + 0.5

	labelLines.forEach((line, index) => {
		ctx.fillText(line, button.x + button.width / 2, firstLineY + index * lineHeight)
	})
}

const layoutGrid = ({ count, startY, maxColumns, minSize, maxSize, slotExtraHeight, rowGap }) => {
	const padding = clamp(state.width * 0.032, 16, 38)
	const gap = clamp(state.width * 0.014, 10, 18)
	const availableWidth = state.width - padding * 2
	let columns = Math.min(Math.max(count, 1), maxColumns)
	let size = Math.floor((availableWidth - gap * (columns - 1)) / columns)

	while (columns > 1 && size < minSize) {
		columns -= 1
		size = Math.floor((availableWidth - gap * (columns - 1)) / columns)
	}

	size = clamp(size, minSize, maxSize)
	const cardHeight = cardHeightFor(size)

	const strideY = cardHeight + slotExtraHeight + rowGap
	const totalWidth = columns * size + gap * (columns - 1)
	const startX = (state.width - totalWidth) / 2
	const positions = []

	for (let index = 0; index < count; index += 1) {
		const column = index % columns
		const row = Math.floor(index / columns)

		positions.push({
			x: startX + column * (size + gap),
			y: startY + row * strideY,
			size
		})
	}

	return {
		positions,
		size,
		height: count === 0 ? 0 : Math.ceil(count / columns) * (cardHeight + slotExtraHeight) + (Math.ceil(count / columns) - 1) * rowGap
	}
}

const drawBackground = () => {
	const gradient = ctx.createLinearGradient(0, 0, 0, state.height)
	gradient.addColorStop(0, THEME.backgroundTop)
	gradient.addColorStop(1, THEME.backgroundBottom)
	ctx.fillStyle = gradient
	ctx.fillRect(0, 0, state.width, state.height)
}

const getTopRightHudLayout = () => {
	const padding = clamp(state.width * 0.028, 14, 34)
	const top = clamp(state.height * 0.08, 30, 52)
	const bottom = state.height - state.footerHeight - padding
	const availableHeight = bottom - top
	const rowGap = 8
	const rowHeight = Math.max(22, Math.floor((availableHeight - rowGap * (CARD_TYPES.length - 1)) / CARD_TYPES.length))
	const baseKeyIconSize = Math.min(30, rowHeight)
	const keyIconSize = baseKeyIconSize * 1.7625
	const keyLabelFontSize = Math.max(14, baseKeyIconSize * 0.6)
	const numberGap = 10
	const maxCountWidth = 24
	const columnWidth = keyIconSize + numberGap + maxCountWidth
	const keyStartX = state.width - padding - columnWidth
	const keyVisible = state.width >= 560 && availableHeight >= 220 && keyStartX >= state.width * 0.78

	return {
		padding,
		top,
		availableHeight,
		rowGap,
		rowHeight,
		keyIconSize,
		keyLabelFontSize,
		numberGap,
		keyStartX,
		keyVisible
	}
}

const drawCardKey = () => {
	const topRightHud = getTopRightHudLayout()

	if (!topRightHud.keyVisible) {
		return
	}

	CARD_TYPES.forEach((type, index) => {
		const y = topRightHud.top + index * (topRightHud.rowHeight + topRightHud.rowGap)
		drawTypeImage(type, topRightHud.keyStartX, y, topRightHud.keyIconSize)

		ctx.fillStyle = THEME.textSoft
		ctx.textAlign = 'left'
		ctx.textBaseline = 'middle'
		ctx.font = `700 ${topRightHud.keyLabelFontSize}px ${mainFont}`
		ctx.fillText(String(type.count), topRightHud.keyStartX + topRightHud.keyIconSize + topRightHud.numberGap, y + topRightHud.keyIconSize / 2)
	})
}


const drawFooter = (title, detail) => {
	const padding = clamp(state.width * 0.032, 16, 38)
	const footerHeight = state.footerHeight
	const top = state.height - footerHeight - padding
	const panelWidth = state.width - padding * 2
	const panelX = padding
	const panelHeight = footerHeight
	const innerPadding = 24
	const contentWidth = panelWidth - innerPadding * 2
	const railWidth = clamp(state.width * 0.2, 138, 188)
	const railGap = 18
	const statAreaWidth = Math.max(0, contentWidth - railWidth - railGap)
	const statGap = 12
	const statWidth = Math.min(210, (statAreaWidth - statGap) / 2)
	const statHeight = 42
	const statBlockWidth = statWidth * 2 + statGap
	const statStartX = panelX + innerPadding + railWidth + railGap + Math.max(0, statAreaWidth - statBlockWidth)
	const statStartY = top + 18
	const railX = panelX + innerPadding
	const helpButtonWidth = railWidth
	const helpButtonY = top + panelHeight - 56
	const roundLabelY = helpButtonY - 10

	fillRoundedRect(panelX, top, panelWidth, panelHeight, 22, THEME.panel)

	ctx.fillStyle = THEME.textSoft
	ctx.textAlign = 'left'
	ctx.textBaseline = 'alphabetic'
	ctx.font = `700 14px ${mainFont}`
	ctx.fillText(`week ${state.roundNumber}`, railX, roundLabelY)

	registerButton({
		id: 'toggle-help',
		label: state.showHowToPlay ? 'close help' : 'how to play',
		x: railX,
		y: helpButtonY,
		width: helpButtonWidth,
		height: 38,
		tone: 'primary',
		action: 'toggle-help'
	})

	const stats = [
		{ label: 'Cash', value: formatMoney(state.displayedCash) },
		{ label: 'Credit', value: formatMoney(state.creditLimit) },
		{ label: savingsLabel(), value: savingsDisplayValue() },
		{ label: 'Items in hand', value: `${state.hand.length}/${currentMaxHandSize()}` }
	]

	stats.forEach((label, index) => {
		const column = index % 2
		const row = Math.floor(index / 2)
		const statX = statStartX + column * (statWidth + statGap)
		const statY = statStartY + row * (statHeight + statGap)
		const highlightSavings = state.phase.startsWith('bonus') && index === 2

		fillRoundedRect(statX, statY, statWidth, statHeight, 14, highlightSavings ? THEME.highlightMuted : THEME.panelSoft)
		ctx.fillStyle = highlightSavings ? THEME.highlightSoft : THEME.textMuted
		ctx.textAlign = 'left'
		ctx.textBaseline = 'alphabetic'
		ctx.font = `600 11px ${mainFont}`
		ctx.fillText(label.label, statX + 14, statY + 16)

		ctx.fillStyle = highlightSavings ? THEME.highlight : index % 2 === 0 ? THEME.text : THEME.highlight
		let valueFontSize = index === 0 ? 24 : 16
		const valueMaxWidth = statWidth - 28

		ctx.font = `700 ${valueFontSize}px ${mainFont}`

		while (valueFontSize > 14 && ctx.measureText(label.value).width > valueMaxWidth) {
			valueFontSize -= 1
			ctx.font = `700 ${valueFontSize}px ${mainFont}`
		}

		ctx.fillText(label.value, statX + 14, statY + (index === 0 ? 39 : 34))
	})
}

const drawBribeHud = () => {
	if (state.bribesRemaining <= 0) {
		return
	}

	const icon = state.images.get('bribe-icon')
	const topRightHud = getTopRightHudLayout()
	const iconSize = 72
	const gap = 12
	const totalWidth = state.bribesRemaining * iconSize + Math.max(0, state.bribesRemaining - 1) * gap
	const startX = topRightHud.keyVisible
		? topRightHud.keyStartX - 18 - totalWidth
		: state.width - clamp(state.width * 0.024, 16, 28) - totalWidth
	const y = topRightHud.keyVisible ? Math.max(16, topRightHud.top - Math.round((iconSize - topRightHud.keyIconSize) / 2)) : 16

	for (let index = 0; index < state.bribesRemaining; index += 1) {
		const x = startX + index * (iconSize + gap)

		if (icon) {
			ctx.drawImage(icon, x, y, iconSize, iconSize)
			continue
		}

		ctx.fillStyle = '#b99448'
		ctx.fillRect(x, y, iconSize, iconSize)
	}
}

const drawHowToPlayOverlay = () => {
	const modalBottom = state.height - state.footerHeight
	const usableHeight = modalBottom
	const overlayWidth = Math.min(760, state.width - 28)
	const overlayHeight = Math.min(540, usableHeight - 12)
	const x = (state.width - overlayWidth) / 2
	const y = (usableHeight - overlayHeight) / 2
	const innerPadding = 26
	const contentWidth = overlayWidth - innerPadding * 2
	const chipGap = 8
	const baseIconSize = 43
	const iconSize = baseIconSize * 1.6
	const chipHeight = baseIconSize + 24
	const chipWidth = Math.max(132, Math.floor((contentWidth - chipGap) / 2))
	const chipTextX = 12 + 43 + 12 + 20

	ctx.fillStyle = 'rgba(7, 10, 13, 0.82)'
	ctx.fillRect(0, 0, state.width, state.height)
	fillRoundedRect(x, y, overlayWidth, overlayHeight, 24, THEME.panel)

	ctx.fillStyle = THEME.highlight
	ctx.textAlign = 'left'
	ctx.textBaseline = 'alphabetic'
	ctx.font = `700 24px ${mainFont}`
	ctx.fillText('how to play', x + innerPadding, y + 40)

	ctx.font = `500 14px ${mainFont}`
	ctx.fillStyle = THEME.textSoft
	const introHeight = drawWrappedInlineText(HOW_TO_PLAY_INTRO, x + innerPadding, y + 78, contentWidth, 20, THEME.textSoft)
	const headingY = y + 78 + introHeight + 26
	const fireImage = state.images.get('fire')

	ctx.textAlign = 'left'
	ctx.textBaseline = 'alphabetic'
	ctx.font = `500 14px ${mainFont}`
	ctx.fillStyle = THEME.textSoft
	ctx.fillText(HOW_TO_PLAY_HEAT_LINE, x + innerPadding, headingY)
	const heatLinePrefixWidth = ctx.measureText(HOW_TO_PLAY_HEAT_LINE).width
	ctx.fillStyle = THEME.heat
	ctx.fillText(' heat', x + innerPadding + heatLinePrefixWidth + 2, headingY)
	const heatWordWidth = ctx.measureText(' heat').width
	const iconX = x + innerPadding + heatLinePrefixWidth + heatWordWidth + 8
	const heatDetailStartX = iconX + (fireImage ? 22 : 0)
	const lineHeight = 20
	const firstLineWidth = x + innerPadding + contentWidth - heatDetailStartX
	const heatDetailWords = HOW_TO_PLAY_HEAT_OUTRO.split(' ')
	const heatDetailLines = []
	let currentLine = ''
	let maxWidth = firstLineWidth

	if (fireImage) {
		ctx.drawImage(fireImage, iconX, headingY - 14, 16, 16)
	}

	heatDetailWords.forEach(word => {
		const candidate = currentLine ? `${currentLine} ${word}` : word

		if (ctx.measureText(candidate).width <= maxWidth || !currentLine) {
			currentLine = candidate
			return
		}

		heatDetailLines.push(currentLine)
		currentLine = word
		maxWidth = contentWidth
	})

	if (currentLine) {
		heatDetailLines.push(currentLine)
	}

	ctx.fillStyle = THEME.textSoft
	heatDetailLines.forEach((line, index) => {
		ctx.fillText(line, index === 0 ? heatDetailStartX : x + innerPadding, headingY + index * lineHeight)
	})

	const heatDetailHeight = Math.max(lineHeight, heatDetailLines.length * lineHeight)

	ctx.font = `500 14px ${mainFont}`
	ctx.fillStyle = THEME.textSoft
	const deckNoteTop = headingY + heatDetailHeight + 14
	const deckNoteHeight = drawWrappedText(HOW_TO_PLAY_OUTRO, x + innerPadding, deckNoteTop, contentWidth, 20, THEME.textSoft)
	const chipsTop = deckNoteTop + deckNoteHeight + 16

	CARD_TYPES.forEach((type, index) => {
		const column = index % 2
		const row = Math.floor(index / 2)
		const chipX = x + innerPadding + column * (chipWidth + chipGap)
		const chipY = chipsTop + row * (chipHeight + chipGap)
		const deckListLabel = type.key === 'silverware' && type.count === 1 ? '1 silverware set' : `${type.count} ${type.plural.toLowerCase()}`

		fillRoundedRect(chipX, chipY, chipWidth, chipHeight, 12, THEME.panelSoft)
		drawTypeImage(type, chipX + 12, chipY + (chipHeight - iconSize) / 2, iconSize)

		ctx.fillStyle = THEME.text
		ctx.textAlign = 'left'
		ctx.textBaseline = 'middle'
		ctx.font = `600 21px ${mainFont}`
		ctx.fillText(deckListLabel, chipX + chipTextX, chipY + chipHeight / 2)
	})

	registerButton({
		id: 'close-help',
		label: 'close',
		x: x + overlayWidth - 112,
		y: y + 18,
		width: 86,
		height: 30,
		tone: 'muted',
		action: 'toggle-help'
	})
}

const drawDebtBonusOfferCard = (card, x, y, size) => {
	const bonusCard = card.bonusCard
	const cardHeight = cardHeightFor(size)
	const outlineWidth = Math.max(3, size * 0.034)
	const image = state.images.get(bonusCard.imageKey)
	const titleLines = bonusCard.key === 'legitimateBusiness' ? ['Legitimate', 'Business'] : [bonusCard.name]
	const titleSize = titleLines.length > 1 ? Math.max(10, size * 0.082) : Math.max(11, size * 0.092)
	const titleLineHeight = titleLines.length > 1 ? titleSize - 1 : titleSize
	const titleBlockHeight = titleLines.length * titleLineHeight
	const legitimateBusinessImageScale = bonusCard.key === 'legitimateBusiness' ? 0.85 : 1
	const legitimateBusinessImageYOffset = bonusCard.key === 'legitimateBusiness' ? -4 : 0
	const imageSize = size * 0.72 * 1.2 * legitimateBusinessImageScale
	const descriptionSize = Math.max(8, size * 0.058)
	const innerX = x + 10
	const innerWidth = size - 20
	const titleTop = y + 22
	const imageY = y + 18 + titleBlockHeight + legitimateBusinessImageYOffset

	ctx.fillStyle = THEME.card
	ctx.fillRect(x, y, size, cardHeight)
	ctx.lineWidth = outlineWidth
	ctx.strokeStyle = bonusCard.accent
	ctx.strokeRect(x + outlineWidth / 2, y + outlineWidth / 2, size - outlineWidth, cardHeight - outlineWidth)

	ctx.textAlign = 'center'
	ctx.textBaseline = 'alphabetic'

	ctx.fillStyle = THEME.cardText
	ctx.font = `700 ${titleSize}px ${mainFont}`
	titleLines.forEach((line, index) => {
		ctx.fillText(line, x + size / 2, titleTop + titleSize + index * titleLineHeight)
	})

	if (image) {
		ctx.drawImage(image, x + (size - imageSize) / 2, imageY, imageSize, imageSize)
	}

	ctx.fillStyle = THEME.cardTextSoft
	ctx.font = `600 ${descriptionSize}px ${mainFont}`
	const descriptionLines = wrapTextLines(bonusCard.description, innerWidth)
	descriptionLines.slice(0, 3).forEach((line, index) => {
		ctx.fillText(line, x + size / 2, y + cardHeight - 28 - (descriptionLines.slice(0, 3).length - 1 - index) * 11)
	})
}

const drawCardFace = (card, x, y, size, footerText, footerLabel = 'sell for') => {
	if (isDebtBonusOffer(card)) {
		drawDebtBonusOfferCard(card, x, y, size)
		return
	}

	const cardHeight = cardHeightFor(size)
	const outlineWidth = Math.max(3, size * 0.034)
	const compactCard = size < 76
	ctx.fillStyle = THEME.card
	ctx.fillRect(x, y, size, cardHeight)
	ctx.lineWidth = outlineWidth
	ctx.strokeStyle = card.type.accent
	ctx.strokeRect(x + outlineWidth / 2, y + outlineWidth / 2, size - outlineWidth, cardHeight - outlineWidth)

	const cornerInset = compactCard ? Math.max(6, size * 0.07) : Math.max(10, size * 0.09)
	const cornerFontSize = compactCard ? Math.max(11, size * 0.12) : Math.max(16, size * 0.18)
	const rankLabel = String(card.rank)

	ctx.fillStyle = THEME.cardText
	ctx.textAlign = 'left'
	ctx.textBaseline = 'top'
	ctx.font = `700 ${cornerFontSize}px ${mainFont}`
	ctx.fillText(rankLabel, x + cornerInset, y + cornerInset)
	drawHeatBadge(card, x, y, size)

	ctx.save()
	ctx.translate(x + size - cornerInset, y + cardHeight - cornerInset)
	ctx.rotate(Math.PI)
	ctx.textAlign = 'left'
	ctx.textBaseline = 'top'
	ctx.font = `700 ${cornerFontSize}px ${mainFont}`
	ctx.fillText(rankLabel, 0, 0)
	ctx.restore()

	const image = getTypeImageAsset(card.type)
	const imageSize = size * (compactCard ? 0.39 : 0.66)
	const imageY = y + cardHeight * (compactCard ? 0.22 : 0.17)

	if (image) {
		ctx.drawImage(image, x + (size - imageSize) / 2, imageY, imageSize, imageSize)
	} else {
		ctx.fillStyle = card.type.accent
		ctx.textAlign = 'center'
		ctx.textBaseline = 'middle'
		ctx.font = `700 ${Math.max(16, size * 0.14)}px ${mainFont}`
		ctx.fillText(card.type.singular[0], x + size / 2, y + cardHeight * 0.42)
	}

	if (footerText) {
		const footerHeight = compactCard ? Math.max(29, size * 0.25) : Math.max(50, size * 0.36)
		const footerY = y + cardHeight - footerHeight - (compactCard ? 5 : 10)
		const footerLabelSize = compactCard ? Math.max(6, size * 0.056) : Math.max(10, size * 0.08)
		const footerPriceSize = compactCard ? Math.max(8, size * 0.078) : Math.max(14, size * 0.125)
		const footerTopPadding = compactCard ? 4 : 8
		const footerGap = compactCard ? 1 : 7

		ctx.textAlign = 'center'
		ctx.textBaseline = 'top'
		ctx.fillStyle = THEME.cardTextSoft
		ctx.font = `600 ${footerLabelSize}px ${mainFont}`
		ctx.fillText(footerLabel, x + size / 2, footerY + footerTopPadding)
		ctx.fillStyle = THEME.cardText
		ctx.font = `600 ${footerPriceSize}px ${mainFont}`
		ctx.fillText(footerText, x + size / 2, footerY + footerTopPadding + footerLabelSize + footerGap)
	}
}

const drawHeatRollOverlay = () => {
	if (!state.sellHeatCheck) {
		return
	}

	const statusLabel = sellHeatOutcomeLabel(state.sellHeatCheck)
	const headerFont = `600 14px ${mainFont}`
	ctx.font = headerFont
	const headerPadding = 28
	const overlayWidth = Math.max(244, Math.min(state.width - 28, Math.ceil(ctx.measureText(statusLabel).width + headerPadding * 2)))
	const overlayHeight = 118
	const x = (state.width - overlayWidth) / 2
	const y = (state.height - overlayHeight) / 2
	const reels = state.sellHeatCheck.reels || []

	fillRoundedRect(x, y, overlayWidth, overlayHeight, 18, THEME.panel)
	ctx.textAlign = 'center'
	ctx.textBaseline = 'alphabetic'
	ctx.fillStyle = THEME.textSoft
	ctx.font = headerFont
	ctx.fillText(statusLabel, state.width / 2, y + 28)

	const reelY = y + 42
	const reelWidth = 52
	const reelHeight = 48
	const reelGap = 10
	const leftX = state.width / 2 - reelWidth - reelGap / 2
	const rightX = state.width / 2 + reelGap / 2
	const drawReel = (reelX, reel) => {
		fillRoundedRect(reelX, reelY, reelWidth, reelHeight, 10, THEME.panelSoft)
		ctx.save()
		ctx.beginPath()
		ctx.rect(reelX, reelY, reelWidth, reelHeight)
		ctx.clip()
		ctx.fillStyle = THEME.highlight
		ctx.textAlign = 'center'
		ctx.textBaseline = 'middle'
		ctx.font = `700 28px ${mainFont}`
		const digitStep = 30
		const position = reel ? reel.position : 0
		const whole = Math.floor(position)
		const offset = (position - whole) * digitStep
		for (let index = -2; index <= 2; index += 1) {
			const digit = (whole + index + 100) % 10
			const digitY = reelY + reelHeight / 2 + index * digitStep - offset
			ctx.globalAlpha = index === 0 ? 1 : 0.34
			ctx.fillText(String(digit), reelX + reelWidth / 2, digitY)
		}
		ctx.restore()
	}

	drawReel(leftX, reels[0])
	drawReel(rightX, reels[1])

	ctx.fillStyle = THEME.textSoft
	ctx.font = `700 22px ${mainFont}`
	ctx.fillText('%', state.width / 2 + 74, reelY + reelHeight / 2)
}

const drawConfiscationFlash = (x, y, size, progress) => {
	const cardHeight = cardHeightFor(size)
	ctx.save()
	ctx.globalAlpha = (1 - progress) * 0.72
	ctx.fillStyle = THEME.heatFlash
	ctx.fillRect(x, y, size, cardHeight)
	ctx.strokeStyle = THEME.heatSoft
	ctx.lineWidth = 3
	ctx.strokeRect(x + 1.5, y + 1.5, size - 3, cardHeight - 3)
	ctx.restore()
}

const drawCardBack = (x, y, size) => {
	const cardHeight = cardHeightFor(size)
	const outlineWidth = Math.max(3, size * 0.034)
	ctx.fillStyle = THEME.cardBack
	ctx.fillRect(x, y, size, cardHeight)
	ctx.lineWidth = outlineWidth
	ctx.strokeStyle = THEME.highlight
	ctx.strokeRect(x + outlineWidth / 2, y + outlineWidth / 2, size - outlineWidth, cardHeight - outlineWidth)

	const questionMarkImage = state.images.get('question-mark')
	const imageSize = size * 1.08
	const imageX = x + (size - imageSize) / 2
	const imageY = y + (cardHeight - imageSize) / 2

	ctx.save()
	ctx.globalAlpha = 0.6

	if (questionMarkImage) {
		ctx.drawImage(questionMarkImage, imageX, imageY, imageSize, imageSize)
	} else {
		ctx.fillStyle = THEME.text
		ctx.textAlign = 'center'
		ctx.textBaseline = 'middle'
		ctx.font = `700 ${Math.max(22, size * 0.24)}px ${mainFont}`
		ctx.fillText('?', x + size / 2, y + cardHeight / 2)
	}

	ctx.restore()
}

const drawAnimatedCard = ({ card, x, y, size, footerText, footerLabel = 'sell for', face = 'front', flipProgress = null }) => {
	const cardHeight = cardHeightFor(size)

	if (flipProgress === null) {
		if (face === 'back') {
			drawCardBack(x, y, size)
			return
		}

		drawCardFace(card, x, y, size, footerText, footerLabel)
		return
	}

	const visibleFace = flipProgress < 0.5 ? 'back' : 'front'
	const scaleX = Math.max(0.04, Math.abs(1 - flipProgress * 2))

	ctx.save()
	ctx.translate(x + size / 2, y + cardHeight / 2)
	ctx.scale(scaleX, 1)

	if (visibleFace === 'back') {
		drawCardBack(-size / 2, -cardHeight / 2, size)
	} else {
		drawCardFace(card, -size / 2, -cardHeight / 2, size, footerText, footerLabel)
	}

	ctx.restore()
}

const drawSectionHeading = (title, subtitle, y) => {
	ctx.textAlign = 'center'
	ctx.textBaseline = 'alphabetic'
	ctx.fillStyle = THEME.highlight
	ctx.font = `700 22px ${mainFont}`
	ctx.fillText(title, state.width / 2, y)
	ctx.fillStyle = THEME.textSoft
	ctx.font = `500 14px ${mainFont}`
	ctx.fillText(subtitle, state.width / 2, y + 24)
}

const drawEmptyState = (label, y) => {
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillStyle = THEME.textMuted
	ctx.font = `500 17px ${mainFont}`
	ctx.fillText(label, state.width / 2, y)
}

const drawHandStrip = startY => {
	const previousHandSlots = new Map(state.handRenderSlots)
	state.handRenderSlots.clear()

	if (state.hand.length === 0) {
		return { height: 0 }
	}

	const grid = layoutGrid({
		count: state.hand.length,
		startY,
		maxColumns: 8,
		minSize: 73,
		maxSize: 103,
		slotExtraHeight: 0,
		rowGap: 18
	})

	state.hand.forEach((card, index) => {
		const slot = grid.positions[index]
		const previousSlot = previousHandSlots.get(card.id)
		const motion = ensureHandShiftMotion(card.id, previousSlot, slot.x, slot.y, slot.size)
		const animated = motion?.kind === 'to-hand' || motion?.kind === 'hand-shift' ? getMotionPosition(motion) : null
		const currentPosition = animated || slot

		state.handRenderSlots.set(card.id, {
			x: currentPosition.x,
			y: currentPosition.y,
			size: currentPosition.size
		})

		if (animated) {
			return
		}

		drawCardFace(card, slot.x, slot.y, slot.size, formatMoney(currentSellValueForCard(card)))
	})

	return { height: grid.height }
}

const getBuyRowLayout = (startY, count) => {
	const padding = clamp(state.width * 0.032, 16, 38)
	const gap = clamp(state.width * 0.012, 6, 14)
	const totalSlots = currentBuyQueueCapacity() + 1
	let size = Math.round(152 * BUY_QUEUE_CARD_SCALE)
	const maxWidth = state.width - padding * 2

	while (size > 56 && size * totalSlots + gap * (totalSlots - 1) > maxWidth) {
		size -= 2
	}

	size = clamp(size, 56, Math.round(152 * BUY_QUEUE_CARD_SCALE))
	const cardHeight = cardHeightFor(size)

	const totalWidth = size * totalSlots + gap * (totalSlots - 1)
	const startX = (state.width - totalWidth) / 2
	const positions = []

	for (let index = 0; index < count; index += 1) {
		positions.push({
			x: startX + index * (size + gap),
			y: startY,
			size
		})
	}

	return {
		positions,
		deckRect: {
			x: startX + currentBuyQueueCapacity() * (size + gap),
			y: startY,
			size
		},
		height: cardHeight + 106
	}
}

const drawDeck = deckRect => {
	const stageRemaining = Math.max(0, currentStageLimit() - state.dealCursor)

	if (stageRemaining === 0 && state.queue.length === 0) {
		return
	}

	const offset = Math.max(6, deckRect.size * 0.06)

	drawCardBack(deckRect.x + offset, deckRect.y + offset, deckRect.size)
	drawCardBack(deckRect.x, deckRect.y, deckRect.size)
}

const drawMovingHandCards = () => {
	state.hand.forEach(card => {
		const motion = state.cardMotions.get(card.id)

		if (motion?.kind !== 'to-hand' && motion?.kind !== 'hand-shift') {
			return
		}

		const animated = getMotionPosition(motion)
		drawCardFace(card, animated.x, animated.y, animated.size, formatMoney(currentSellValueForCard(card)))
	})
}

const drawBuyScene = () => {
	const previewGrid = getBuyRowLayout(0, state.queue.length || currentBuyQueueCapacity())
	const handTop = previewGrid.height + 20
	const handContentHeight = layoutGrid({
		count: Math.max(state.hand.length, 1),
		startY: 0,
		maxColumns: 8,
		minSize: 73,
		maxSize: 103,
		slotExtraHeight: 0,
		rowGap: 18
	}).height
	const contentHeight = previewGrid.height + 20 + handContentHeight
	const sectionTop = centeredSectionTop(contentHeight)

	if (state.queue.length === 0) {
		drawEmptyState('No more offers. The sell round is next.', sectionTop + 110)
		return
	}

	const grid = getBuyRowLayout(sectionTop, state.queue.length)
	const previousQueueSlots = new Map(state.queueRenderSlots)
	state.queueRenderSlots.clear()
	state.deckRect = grid.deckRect
	drawDeck(grid.deckRect)

	state.queue.forEach((card, index) => {
		const position = grid.positions[index]
		const previousSlot = previousQueueSlots.get(card.id)
		const motion = previousSlot
			? ensureQueueShiftMotion(card.id, previousSlot, position.x, position.y, position.size)
			: ensureDeckToQueueMotion(card.id, grid.deckRect, position.x, position.y, position.size)
		const animated = motion?.kind === 'from-deck' ? getMotionPosition(motion) : position
		const shifted = motion?.kind === 'queue-shift' ? getMotionPosition(motion) : null
		const currentPosition = shifted || animated
		const entryProgress = motion?.kind === 'from-deck' ? getMotionProgress(motion) : motion?.kind === 'queue-shift' ? getMotionProgress(motion) : 1
		const interactionReady = motion?.kind === 'from-deck' ? entryProgress >= 0.98 : motion?.kind === 'queue-shift' ? entryProgress >= 0.9 : true
		const buyPrice = buyPriceForCard(card)
		const marketValue = marketValueForCard(card)
		const bonusOffer = isDebtBonusOffer(card)
		const canAfford = state.cash >= buyPrice
		const canCarry = state.hand.length < currentMaxHandSize()
		const buyEnabled = canAfford && (bonusOffer || canCarry)
		const footerText = bonusOffer || (motion?.kind === 'from-deck' && getMotionProgress(motion) < 0.5) ? null : formatMoney(marketValue)
		const compactLabels = currentPosition.size < 72
		const buyLabel = `buy for\n${compactLabels ? formatCompactMoney(buyPrice) : formatMoney(buyPrice)}`
		const rejectLabel = compactLabels ? 'No' : 'Reject'

		state.queueRenderSlots.set(card.id, {
			x: currentPosition.x,
			y: currentPosition.y,
			size: currentPosition.size
		})

		drawAnimatedCard({
			card,
			x: currentPosition.x,
			y: currentPosition.y,
			size: currentPosition.size,
			footerText,
			flipProgress: motion?.kind === 'from-deck' ? getFastFlipProgress(getMotionProgress(motion)) : null
		})

		registerButton({
			id: `buy-${card.id}`,
			label: buyLabel,
			x: currentPosition.x,
			y: currentPosition.y + cardHeightFor(currentPosition.size) + 18,
			width: currentPosition.size,
			height: 44,
			tone: 'buy',
			enabled: buyEnabled,
			action: 'buy',
			payload: card.id
		})

		registerButton({
			id: `reject-${card.id}`,
			label: rejectLabel,
			x: currentPosition.x,
			y: currentPosition.y + cardHeightFor(currentPosition.size) + 68,
			width: currentPosition.size,
			height: 30,
			tone: 'reject',
			enabled: true,
			action: 'reject',
			payload: card.id
		})
	})

	pruneCardMotion()

	drawHandStrip(sectionTop + handTop)
	drawMovingHandCards()
	drawFooter(
		buyRoundTitle(state.buyStage),
		`${state.notice} Seen ${cardsSeenInStage()}/${BUY_STAGE_SIZE} cards from ${deckSliceLabel(state.buyStage)}.`
	)
}

const drawBonusCardFace = (bonusCard, x, y, width) => {
	const remaining = remainingBonusCopies(bonusCard.key)
	const stackDepth = Math.max(1, Math.min(remaining, bonusCard.quantity))
	const stackOffsetX = 16
	const stackOffsetY = 10
	const height = Math.round(width * 1.54)
	const baseX = x + (stackDepth - 1) * stackOffsetX
	const foregroundX = x
	const image = state.images.get(bonusCard.imageKey)
	const cardCenterX = foregroundX + width / 2
	const innerX = foregroundX + 16
	const innerWidth = width - 32
	const titleLines = bonusCard.key === 'legitimateBusiness' ? ['Legitimate', 'Business'] : [bonusCard.name]
	const titleSize = titleLines.length > 1 ? 16 : 18
	const titleLineHeight = titleLines.length > 1 ? 16 : 18
	const titleBlockHeight = titleLines.length * titleLineHeight
	const bodySize = 11
	const bodyLineHeight = 15
	const metaLineHeight = 16
	const costLine = `Cost: ${formatMoney(bonusCard.cost)}`
	const overheadLine =
		bonusCard.overheadLabel || `${bonusCard.overheadDelta < 0 ? '-' : '+'}${formatMoney(Math.abs(bonusCard.overheadDelta))} weekly overhead`
	const overheadLineColor = bonusCard.overheadLabel || bonusCard.overheadDelta <= 0 ? '#2b6654' : '#7a523d'

	ctx.font = `600 ${bodySize}px ${mainFont}`
	const descriptionLines = wrapTextLines(bonusCard.description, innerWidth)
	const descriptionHeight = descriptionLines.length * bodyLineHeight
	const imageSize = clamp(Math.min(width * 0.624, height - descriptionHeight - metaLineHeight * 2 - 112), 74, 134)
	const contentHeight = titleBlockHeight + 22 + imageSize + 18 + descriptionHeight + 12 + metaLineHeight * 2
	const contentTop = y + Math.max(28, Math.floor((height - contentHeight) / 2))
	const titleY = contentTop + titleSize
	const ruleY = contentTop + titleBlockHeight + 10
	const imageTop = ruleY + 12
	const descriptionTop = imageTop + imageSize + 18
	const costY = descriptionTop + descriptionHeight + 12
	const overheadY = costY + metaLineHeight

	const drawCardLayer = (layerX, layerY, rotation) => {
		ctx.save()
		ctx.translate(layerX + width / 2, layerY + height / 2)
		ctx.rotate(rotation)
		ctx.translate(-width / 2, -height / 2)
		ctx.fillStyle = THEME.card
		ctx.fillRect(0, 0, width, height)
		ctx.lineWidth = Math.max(3, width * 0.028)
		ctx.strokeStyle = bonusCard.accent
		ctx.strokeRect(1.5, 1.5, width - 3, height - 3)
		ctx.restore()
	}

	for (let index = stackDepth - 1; index >= 0; index -= 1) {
		const layerX = x + index * stackOffsetX
		const layerY = y - index * stackOffsetY
		drawCardLayer(layerX, layerY, index * 0.026)
	}

	ctx.fillStyle = THEME.cardText
	ctx.textAlign = 'center'
	ctx.textBaseline = 'alphabetic'
	ctx.font = `700 ${titleSize}px ${mainFont}`
	titleLines.forEach((line, index) => {
		ctx.fillText(line, cardCenterX, titleY + index * titleLineHeight)
	})

	ctx.strokeStyle = bonusCard.accent
	ctx.lineWidth = 2
	ctx.beginPath()
	ctx.moveTo(foregroundX + 18, ruleY)
	ctx.lineTo(foregroundX + width - 18, ruleY)
	ctx.stroke()

	if (image) {
		ctx.drawImage(image, foregroundX + (width - imageSize) / 2, imageTop, imageSize, imageSize)
	}

	ctx.fillStyle = THEME.cardText
	ctx.textAlign = 'left'
	ctx.font = `600 ${bodySize}px ${mainFont}`
	descriptionLines.forEach((line, index) => {
		ctx.fillText(line, innerX, descriptionTop + index * bodyLineHeight)
	})

	ctx.fillStyle = THEME.cardTextSoft
	ctx.font = `600 ${bodySize}px ${mainFont}`
	ctx.fillText(costLine, innerX, costY)
	ctx.fillStyle = overheadLineColor
	ctx.fillText(overheadLine, innerX, overheadY)

	return { x: foregroundX, y, width, height }
}

const drawBonusScene = () => {
	const padding = clamp(state.width * 0.05, 24, 54)
	const gap = clamp(state.width * 0.045, 32, 60)
	const availableWidth = state.width - padding * 2 - gap * (BONUS_CARDS.length - 1)
	const cardWidth = clamp(Math.floor(availableWidth / BONUS_CARDS.length), 168, 214)
	const cardHeight = Math.round(cardWidth * 1.54)
	const totalWidth = BONUS_CARDS.length * cardWidth + gap * (BONUS_CARDS.length - 1)
	const startX = (state.width - totalWidth) / 2
	const headingY = clamp(state.height * 0.11, 68, 92)
	const subtitleY = headingY + 26
	const stackRise = 20
	const buttonGap = 18
	const buttonHeight = 40
	const subtitle = state.savings > 0 ? 'Use your savings to buy bonuses.' : 'Get out of debt to buy bonuses.'
	const minSectionTop = subtitleY + 40 + stackRise
	const maxSectionTop = state.height - state.footerHeight - buttonHeight - buttonGap - cardHeight - 34
	const sectionTop = clamp(Math.round((minSectionTop + maxSectionTop) / 2) - 40, minSectionTop, maxSectionTop)

	ctx.textAlign = 'center'
	ctx.textBaseline = 'alphabetic'
	ctx.fillStyle = THEME.highlight
	ctx.font = `700 24px ${mainFont}`
	ctx.fillText(bonusRoundTitle(), state.width / 2, headingY)
	ctx.fillStyle = THEME.textSoft
	ctx.font = `500 14px ${mainFont}`
	ctx.fillText(subtitle, state.width / 2, subtitleY)

	BONUS_CARDS.forEach((bonusCard, index) => {
		const x = startX + index * (cardWidth + gap)
		const cardFrame = drawBonusCardFace(bonusCard, x, sectionTop, cardWidth)
		const remaining = remainingBonusCopies(bonusCard.key)
		const canBuy = remaining > 0 && state.savings >= bonusCard.cost
		const label = remaining === 0 ? 'Sold out' : `Buy for ${formatCompactMoney(bonusCard.cost)}`

		registerButton({
			id: `bonus-${bonusCard.key}`,
			label,
			x: cardFrame.x,
			y: cardFrame.y + cardFrame.height + buttonGap,
			width: cardFrame.width,
			height: buttonHeight,
			tone: 'primary',
			enabled: canBuy,
			action: 'buy-bonus',
			payload: bonusCard.key
		})
	})

	registerButton({
		id: 'continue-bonus',
		label: 'Finish the week',
		x: (state.width - 280) / 2,
		y: state.height - state.footerHeight - 74,
		width: 280,
		height: 40,
		tone: 'primary',
		action: 'continue-bonus'
	})

	const nextSellRoundDetail =
		currentWeeklyOverhead() < 0
			? `Legitimate income next sell round: ${formatMoney(-currentWeeklyOverhead())}.`
			: `Overhead next sell round: ${formatMoney(currentWeeklyOverhead())}.`

	drawFooter(bonusRoundTitle(), `${state.notice} ${nextSellRoundDetail}`)
}

const drawSellScene = () => {
	pruneCardMotion()
	const previewGrid = layoutGrid({
		count: Math.max(state.hand.length, 1),
		startY: 0,
		maxColumns: 4,
		minSize: 111,
		maxSize: 162,
		slotExtraHeight: 60,
		rowGap: 24
	})
	const sectionTop = centeredSectionTop(previewGrid.height)

	if (state.hand.length === 0) {
		state.handRenderSlots.clear()
		drawEmptyState('No merchandise in hand. End the sell phase when you are ready.', sectionTop + 110)
	} else {
		const previousHandSlots = new Map(state.handRenderSlots)
		state.handRenderSlots.clear()
		const grid = layoutGrid({
			count: state.hand.length,
			startY: sectionTop,
			maxColumns: 4,
			minSize: 111,
			maxSize: 162,
			slotExtraHeight: 60,
			rowGap: 24
		})

		state.hand.forEach((card, index) => {
			const position = grid.positions[index]
			const previousSlot = previousHandSlots.get(card.id)
			const motion = ensureHandShiftMotion(card.id, previousSlot, position.x, position.y, position.size)
			const animated = motion?.kind === 'to-hand' || motion?.kind === 'hand-shift' ? getMotionPosition(motion) : null
			const currentPosition = animated || position
			const currentValue = state.sellHeatCheck ? marketValueForCard(card) : currentSellValueForCard(card)

			state.handRenderSlots.set(card.id, {
				x: currentPosition.x,
				y: currentPosition.y,
				size: currentPosition.size
			})

				const boughtPrice = card.purchasePrice ?? buyPriceForCard(card)
				drawCardFace(
					card,
					currentPosition.x,
					currentPosition.y,
					currentPosition.size,
					state.sellHeatCheck ? null : formatMoney(boughtPrice),
					'bought for'
				)

			if (state.sellHeatCheck?.stage === 'flash' && state.sellHeatCheck.confiscatedIds.includes(card.id)) {
				drawConfiscationFlash(currentPosition.x, currentPosition.y, currentPosition.size, clamp(state.sellHeatCheck.elapsed / SELL_HEAT_FLASH_MS, 0, 1))
			}

			if (!state.sellHeatCheck) {
				registerButton({
					id: `sell-${card.id}`,
					label: `Sell ${formatMoney(currentValue)}`,
					x: currentPosition.x,
					y: currentPosition.y + cardHeightFor(currentPosition.size) + 18,
					width: currentPosition.size,
					height: 38,
					tone: 'sell',
					action: 'sell',
					payload: card.id
				})
			}
		})
	}

	const buttonWidth = Math.min(260, state.width - 32)
	const buttonY = state.height - state.footerHeight - 74
	const actionGap = 14
	const sellAllWidth = Math.min(180, state.width - 32)
	const totalActionWidth = sellAllWidth + actionGap + buttonWidth
	const actionStartX = (state.width - totalActionWidth) / 2

	if (!state.sellHeatCheck) {
		registerButton({
			id: 'sell-all',
			label: 'Sell all',
			x: actionStartX,
			y: buttonY,
			width: sellAllWidth,
			height: 40,
			tone: 'sell',
			enabled: state.hand.length > 0,
			action: 'sell-all'
		})

		registerButton({
			id: 'end-selling',
			label: state.buyStage < TOTAL_BUY_STAGES ? `Start ${stageLabel(state.buyStage + 1).toLowerCase()} buy round` : 'Close the week',
			x: actionStartX + sellAllWidth + actionGap,
			y: buttonY,
			width: buttonWidth,
			height: 40,
			tone: 'primary',
			action: 'end-sell'
		})
	}

	drawFooter(
		sellRoundTitle(state.buyStage),
		state.notice
	)

	if (state.sellHeatCheck) {
		drawHeatRollOverlay()
	}
}

const drawBribePromptOverlay = () => {
	if (!state.sellHeatCheck || state.sellHeatCheck.stage !== 'prompt' || !state.bribePrompt) {
		return
	}

	const overlayWidth = Math.min(540, state.width - 28)
	const overlayHeight = 128
	const x = (state.width - overlayWidth) / 2
	const y = (state.height - overlayHeight) / 2
	const icon = state.images.get('bribe-icon')

	ctx.fillStyle = 'rgba(7, 10, 13, 0.62)'
	ctx.fillRect(0, 0, state.width, state.height)
	fillRoundedRect(x, y, overlayWidth, overlayHeight, 18, THEME.panel)

	if (icon) {
		ctx.drawImage(icon, x + 24, y + 24, 34, 34)
	}

	ctx.textAlign = 'left'
	ctx.textBaseline = 'alphabetic'
	ctx.fillStyle = THEME.text
	ctx.font = `700 20px ${mainFont}`
	ctx.fillText('Spend a bribe for a reroll?', x + 72, y + 46)

	registerButton({
		id: 'use-bribe',
		label: 'Use bribe',
		x: x + 24,
		y: y + overlayHeight - 54,
		width: 170,
		height: 36,
		tone: 'primary',
		action: 'use-bribe'
	})

	registerButton({
		id: 'decline-bribe',
		label: 'Keep it',
		x: x + overlayWidth - 194,
		y: y + overlayHeight - 54,
		width: 170,
		height: 36,
		tone: 'muted',
		action: 'decline-bribe'
	})
}

const drawSummaryScene = () => {
	const panelWidth = Math.min(680, state.width - 28)
	const panelHeight = Math.min(420, state.height - 40)
	const x = (state.width - panelWidth) / 2
	const y = (state.height - panelHeight) / 2
	const profit = state.roundResult.profit
	const creditLineText =
		state.roundResult.actualCreditChange > 0
			? `Credit increased to ${formatMoney(state.roundResult.nextCredit)}.`
			: state.roundResult.actualCreditChange < 0
				? `Credit dropped to ${formatMoney(state.roundResult.nextCredit)}.`
				: `Credit stays at ${formatMoney(state.roundResult.nextCredit)}.`

	fillRoundedRect(x, y, panelWidth, panelHeight, 24, THEME.panel)

	ctx.textAlign = 'center'
	ctx.textBaseline = 'alphabetic'
	ctx.fillStyle = THEME.highlight
	ctx.font = `700 34px ${mainFont}`
	ctx.fillText(`Week ${state.roundNumber}`, state.width / 2, y + 54)
	ctx.font = `500 18px ${mainFont}`
	ctx.fillStyle = THEME.textSoft
	ctx.fillText(state.roundResult.summary, state.width / 2, y + 84)

	const stats = [
		`Cash banked: ${formatMoney(state.roundResult.cashOut)}`,
		`Profit on credit: ${formatMoney(profit)}`,
		`Sale of remaining goods: ${state.roundResult.unsoldCards}`,
		`Total ${savingsLabel().toLowerCase()}: ${savingsDisplayValue()}`
	]

	ctx.textAlign = 'left'
	ctx.font = `600 18px ${mainFont}`
	ctx.fillStyle = THEME.text
	stats.forEach((label, index) => {
		ctx.fillText(label, x + 46, y + 146 + index * 38)
	})

	ctx.font = `500 18px ${mainFont}`
	drawWrappedText(creditLineText, x + 46, y + 316, panelWidth - 92, 24, THEME.textSoft)

	registerButton({
		id: 'next-round',
		label: 'Continue to next week',
		x: x + (panelWidth - 260) / 2,
		y: y + panelHeight - 72,
		width: 260,
		height: 42,
		tone: 'primary',
		action: 'next-round'
	})
}

const drawSellRoundTransitionOverlay = () => {
	if (!state.sellRoundTransition) {
		return
	}

	const message = state.sellRoundTransition.message
	ctx.font = `600 16px ${mainFont}`
	const overlayWidth = Math.min(state.width - 32, Math.max(280, Math.ceil(ctx.measureText(message).width + 56)))
	const overlayHeight = 82
	const x = (state.width - overlayWidth) / 2
	const y = (state.height - overlayHeight) / 2

	ctx.fillStyle = 'rgba(7, 10, 13, 0.48)'
	ctx.fillRect(0, 0, state.width, state.height)
	fillRoundedRect(x, y, overlayWidth, overlayHeight, 18, THEME.panel)

	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillStyle = THEME.text
	ctx.font = `600 16px ${mainFont}`
	ctx.fillText(message, state.width / 2, y + overlayHeight / 2)
}

const drawBuySkipTransitionOverlay = () => {
	if (!state.buySkipTransition) {
		return
	}

	const message = state.buySkipTransition.message
	ctx.font = `600 16px ${mainFont}`
	const overlayWidth = Math.min(state.width - 32, Math.max(320, Math.ceil(ctx.measureText(message).width + 56)))
	const overlayHeight = 82
	const x = (state.width - overlayWidth) / 2
	const y = (state.height - overlayHeight) / 2

	ctx.fillStyle = 'rgba(7, 10, 13, 0.48)'
	ctx.fillRect(0, 0, state.width, state.height)
	fillRoundedRect(x, y, overlayWidth, overlayHeight, 18, THEME.panel)

	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillStyle = THEME.text
	ctx.font = `600 16px ${mainFont}`
	ctx.fillText(message, state.width / 2, y + overlayHeight / 2)
}

const phaseLabel = () => {
	if (state.phase === 'buy-1') {
		return buyRoundTitle(1)
	}

	if (state.phase === 'sell-1') {
		return sellRoundTitle(1)
	}

	if (state.phase === 'buy-2') {
		return buyRoundTitle(2)
	}

	if (state.phase === 'sell-2') {
		return sellRoundTitle(2)
	}

	if (state.phase === 'buy-3') {
		return buyRoundTitle(3)
	}

	if (state.phase === 'sell-3') {
		return sellRoundTitle(3)
	}

	if (state.phase === 'summary') {
		return 'Week summary'
	}

	if (state.phase.startsWith('bonus')) {
		return 'Bonus round'
	}

	if (state.phase === 'start') {
		return 'Start'
	}

	return 'Loading'
}

const render = () => {
	state.buttons = []
	drawBackground()

	if (state.phase === 'loading') {
		ctx.fillStyle = THEME.text
		ctx.textAlign = 'center'
		ctx.textBaseline = 'middle'
		ctx.font = `700 38px ${mainFont}`
		ctx.fillText('FENCE', state.width / 2, state.height / 2 - 24)
		ctx.font = `500 18px ${mainFont}`
		ctx.fillStyle = THEME.textSoft
		ctx.fillText(state.notice, state.width / 2, state.height / 2 + 16)
		return
	}

	if (state.phase === 'start') {
		const titleFontSize = 56
		const titleGap = 56
		const titleText = 'FENCE'
		const centerY = state.height / 2
		const startButtonWidth = 192
		const startButtonHeight = 44

		ctx.fillStyle = THEME.highlight
		ctx.textAlign = 'left'
		ctx.textBaseline = 'middle'
		ctx.font = `700 ${titleFontSize}px ${mainFont}`
		const titleWidth = ctx.measureText(titleText).width
		const totalWidth = titleWidth + titleGap + startButtonWidth
		const titleX = (state.width - totalWidth) / 2
		const buttonX = titleX + titleWidth + titleGap
		const buttonY = centerY - startButtonHeight / 2

		ctx.fillText(titleText, titleX, centerY)

		registerButton({
			id: 'start-game',
			label: 'Start',
			x: buttonX,
			y: buttonY,
			width: startButtonWidth,
			height: startButtonHeight,
			tone: 'primary',
			hoverIconKey: 'jewel-icon',
			action: 'start-game'
		})
		return
	}

	state.footerHeight = footerHeightForPhase()
	state.headerBottom = clamp(state.height * 0.03, 18, 28)

	if (state.phase === 'summary') {
		drawSummaryScene()
	} else if (state.phase.startsWith('buy')) {
		drawBuyScene()
		drawCardKey()
		drawBribeHud()
	} else if (state.phase.startsWith('bonus')) {
		drawBonusScene()
		drawBribeHud()
	} else {
		drawSellScene()
		drawCardKey()
		drawBribeHud()
	}

	if (state.showHowToPlay) {
		drawHowToPlayOverlay()
	}

	if (state.sellRoundTransition) {
		drawSellRoundTransitionOverlay()
	}

	if (state.buySkipTransition) {
		drawBuySkipTransitionOverlay()
	}

	drawBribePromptOverlay()
}

const resizeCanvas = () => {
	const pixelRatio = window.devicePixelRatio || 1

	state.width = window.innerWidth
	state.height = window.innerHeight
	canvas.width = Math.floor(state.width * pixelRatio)
	canvas.height = Math.floor(state.height * pixelRatio)
	canvas.style.width = `${state.width}px`
	canvas.style.height = `${state.height}px`
	ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
	render()
}

const buttonAtPoint = (x, y) => {
	if ((state.sellHeatCheck && state.sellHeatCheck.stage !== 'prompt') || state.sellRoundTransition || state.buySkipTransition) {
		return null
	}

	for (let index = state.buttons.length - 1; index >= 0; index -= 1) {
		const button = state.buttons[index]

		if (
			button.enabled !== false &&
			x >= button.x &&
			x <= button.x + button.width &&
			y >= button.y &&
			y <= button.y + button.height
		) {
			return button
		}
	}

	return null
}

const pointerPosition = event => {
	const bounds = canvas.getBoundingClientRect()

	return {
		x: event.clientX - bounds.left,
		y: event.clientY - bounds.top
	}
}

const runButtonAction = button => {
	if (button.action === 'buy') {
		buyCard(button.payload)
	}

	if (button.action === 'reject') {
		rejectCard(button.payload)
	}

	if (button.action === 'sell') {
		sellCard(button.payload)
	}

	if (button.action === 'sell-all') {
		sellAllCards()
	}

	if (button.action === 'end-sell') {
		endSellPhase()
	}

	if (button.action === 'next-round') {
		nextRound()
	}

	if (button.action === 'toggle-help') {
		state.showHowToPlay = !state.showHowToPlay
	}

	if (button.action === 'start-game') {
		startRound()
	}

	if (button.action === 'buy-bonus') {
		buyBonusCard(button.payload)
	}

	if (button.action === 'continue-bonus') {
		continueFromBonusShop()
	}

	if (button.action === 'use-bribe') {
		spendBribeOnHeatRoll()
	}

	if (button.action === 'decline-bribe') {
		declineBribeOnHeatRoll()
	}

	render()
}

canvas.addEventListener('pointermove', event => {
	const pointer = pointerPosition(event)
	const hoveredButton = buttonAtPoint(pointer.x, pointer.y)
	const hoveredId = hoveredButton ? hoveredButton.id : null

	if (hoveredId === state.hoveredButtonId) {
		return
	}

	state.hoveredButtonId = hoveredId
	canvas.style.cursor = hoveredId ? 'pointer' : 'default'
	render()
})

canvas.addEventListener('pointerdown', event => {
	const pointer = pointerPosition(event)
	const button = buttonAtPoint(pointer.x, pointer.y)

	if (!button) {
		return
	}

	runButtonAction(button)
})

window.addEventListener('resize', resizeCanvas)

const initialize = async () => {
	resizeCanvas()
	await Promise.all([loadCardImages(), document.fonts.ready])
	state.phase = 'start'
	render()
}

initialize()