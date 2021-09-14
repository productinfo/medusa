import _ from "lodash"
import { BaseService } from "medusa-interfaces"
import { MedusaError } from "medusa-core-utils"

/**
 * Handles Returns
 * @implements BaseService
 */
class ReturnService extends BaseService {
  constructor({
    manager,
    totalsService,
    lineItemService,
    returnRepository,
    returnItemRepository,
    shippingOptionService,
    returnReasonService,
    fulfillmentProviderService,
    inventoryService,
    orderService,
  }) {
    super()

    /** @private @const {EntityManager} */
    this.manager_ = manager

    /** @private @const {TotalsService} */
    this.totalsService_ = totalsService

    /** @private @const {ReturnRepository} */
    this.returnRepository_ = returnRepository

    /** @private @const {ReturnItemRepository} */
    this.returnItemRepository_ = returnItemRepository

    /** @private @const {ReturnItemRepository} */
    this.lineItemService_ = lineItemService

    /** @private @const {ShippingOptionService} */
    this.shippingOptionService_ = shippingOptionService

    /** @private @const {FulfillmentProviderService} */
    this.fulfillmentProviderService_ = fulfillmentProviderService

    this.returnReasonService_ = returnReasonService

    this.inventoryService_ = inventoryService

    /** @private @const {OrderService} */
    this.orderService_ = orderService
  }

  withTransaction(transactionManager) {
    if (!transactionManager) {
      return this
    }

    const cloned = new ReturnService({
      manager: transactionManager,
      totalsService: this.totalsService_,
      lineItemService: this.lineItemService_,
      returnRepository: this.returnRepository_,
      returnItemRepository: this.returnItemRepository_,
      shippingOptionService: this.shippingOptionService_,
      fulfillmentProviderService: this.fulfillmentProviderService_,
      returnReasonService: this.returnReasonService_,
      inventoryService: this.inventoryService_,
      orderService: this.orderService_,
    })

    cloned.transactionManager_ = transactionManager

    return cloned
  }

  /**
   * Retrieves the order line items, given an array of items
   * @param {Order} order - the order to get line items from
   * @param {{ item_id: string, quantity: number }} items - the items to get
   * @param {function} transformer - a function to apply to each of the items
   *    retrieved from the order, should return a line item. If the transformer
   *    returns an undefined value the line item will be filtered from the
   *    returned array.
   * @return {Promise<Array<LineItem>>} the line items generated by the transformer.
   */
  async getFulfillmentItems_(order, items, transformer) {
    let merged = [...order.items]

    // merge items from order with items from order swaps
    if (order.swaps && order.swaps.length) {
      for (const s of order.swaps) {
        merged = [...merged, ...s.additional_items]
      }
    }

    const toReturn = await Promise.all(
      items.map(async data => {
        const item = merged.find(i => i.id === data.item_id)
        return transformer(item, data.quantity, data)
      })
    )

    return toReturn.filter(i => !!i)
  }

  /**
   * @param {Object} selector - the query object for find
   * @return {Promise} the result of the find operation
   */
  list(
    selector,
    config = { skip: 0, take: 50, order: { created_at: "DESC" } }
  ) {
    const returnRepo = this.manager_.getCustomRepository(this.returnRepository_)
    const query = this.buildQuery_(selector, config)
    return returnRepo.find(query)
  }

  /**
   * Cancels a return if possible. Returns can be canceled if it has not been received.
   * @param {string} returnId - the id of the return to cancel.
   * @return {Promise<Return>} the updated Return
   */
  async cancel(returnId) {
    return this.atomicPhase_(async manager => {
      const ret = await this.retrieve(returnId)

      if (ret.status === "received") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Can't cancel a return which has been returned"
        )
      }

      const retRepo = manager.getCustomRepository(this.returnRepository_)

      ret.status = "canceled"

      const result = retRepo.save(ret)
      return result
    })
  }

  /**
   * Checks that an order has the statuses necessary to complete a return.
   * fulfillment_status cannot be not_fulfilled or returned.
   * payment_status must be captured.
   * @param {Order} order - the order to check statuses on
   * @throws when statuses are not sufficient for returns.
   */
  validateReturnStatuses_(order) {
    if (
      order.fulfillment_status === "not_fulfilled" ||
      order.fulfillment_status === "returned"
    ) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Can't return an unfulfilled or already returned order"
      )
    }

    if (order.payment_status !== "captured") {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Can't return an order with payment unprocessed"
      )
    }
  }

  /**
   * Checks that a given quantity of a line item can be returned. Fails if the
   * item is undefined or if the returnable quantity of the item is lower, than
   * the quantity that is requested to be returned.
   * @param {LineItem?} item - the line item to check has sufficient returnable
   *   quantity.
   * @param {number} quantity - the quantity that is requested to be returned.
   * @param {object} additional - the quantity that is requested to be returned.
   * @return {LineItem} a line item where the quantity is set to the requested
   *   return quantity.
   */
  validateReturnLineItem_(item, quantity, additional) {
    if (!item) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Return contains invalid line item"
      )
    }

    const returnable = item.quantity - item.returned_quantity
    if (quantity > returnable) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "Cannot return more items than have been purchased"
      )
    }

    const toReturn = {
      ...item,
      quantity,
    }

    if ("reason_id" in additional) {
      toReturn.reason_id = additional.reason_id
    }

    if ("note" in additional) {
      toReturn.note = additional.note
    }

    return toReturn
  }

  /**
   * Retrieves a return by its id.
   * @param {string} id - the id of the return to retrieve
   * @return {Return} the return
   */
  async retrieve(id, config = {}) {
    const returnRepository = this.manager_.getCustomRepository(
      this.returnRepository_
    )

    const validatedId = this.validateId_(id)
    const query = this.buildQuery_({ id: validatedId }, config)

    const returnObj = await returnRepository.findOne(query)

    if (!returnObj) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Return with id: ${id} was not found`
      )
    }
    return returnObj
  }

  async retrieveBySwap(swapId, relations = []) {
    const returnRepository = this.manager_.getCustomRepository(
      this.returnRepository_
    )

    const validatedId = this.validateId_(swapId)

    const returnObj = await returnRepository.findOne({
      where: {
        swap_id: validatedId,
      },
      relations,
    })

    if (!returnObj) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Return with swa_id: ${swapId} was not found`
      )
    }
    return returnObj
  }

  async update(returnId, update) {
    return this.atomicPhase_(async manager => {
      const ret = await this.retrieve(returnId)

      if (ret.status === "canceled") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Cannot update a canceled return"
        )
      }

      const { metadata, ...rest } = update

      if ("metadata" in update) {
        ret.metadata = this.setMetadata_(ret, update.metadata)
      }

      for (const [key, value] of Object.entries(rest)) {
        ret[key] = value
      }

      const retRepo = manager.getCustomRepository(this.returnRepository_)
      const result = await retRepo.save(ret)
      return result
    })
  }

  /**
   * Creates a return request for an order, with given items, and a shipping
   * method. If no refund amount is provided the refund amount is calculated from
   * the return lines and the shipping cost.
   * @param {object} data - data to use for the return e.g. shipping_method,
   *    items or refund_amount
   * @param {object} orderLike - order object
   * @returns {Promise<Return>} the resulting order.
   */
  async create(data) {
    return this.atomicPhase_(async manager => {
      const returnRepository = manager.getCustomRepository(
        this.returnRepository_
      )

      let orderId = data.order_id
      if (data.swap_id) {
        delete data.order_id
      }

      for (const item of data.items) {
        const line = await this.lineItemService_.retrieve(item.item_id, {
          relations: ["order", "swap", "claim_order"],
        })

        if (
          line.order?.canceled_at ||
          line.swap?.canceled_at ||
          line.claim_order?.canceled_at
        ) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Cannot create a return for a canceled item.`
          )
        }
      }

      const order = await this.orderService_
        .withTransaction(manager)
        .retrieve(orderId, {
          select: ["refunded_total", "total", "refundable_amount"],
          relations: ["swaps", "swaps.additional_items", "items"],
        })

      const returnLines = await this.getFulfillmentItems_(
        order,
        data.items,
        this.validateReturnLineItem_
      )

      if (data.shipping_method) {
        if (typeof data.shipping_method.price === "undefined") {
          const opt = await this.shippingOptionService_.retrieve(
            data.shipping_method.option_id
          )
          data.shipping_method.price = opt.amount
        }
      }

      let toRefund = data.refund_amount
      if (typeof toRefund !== "undefined") {
        // refundable from order
        let refundable = order.refundable_amount

        if (toRefund > refundable) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "Cannot refund more than the original payment"
          )
        }
      } else {
        toRefund = await this.totalsService_.getRefundTotal(order, returnLines)

        if (data.shipping_method) {
          toRefund = Math.max(
            0,
            toRefund - data.shipping_method.price * (1 + order.tax_rate / 100)
          )
        }
      }

      const method = data.shipping_method
      delete data.shipping_method

      const returnObject = {
        ...data,
        status: "requested",
        refund_amount: Math.floor(toRefund),
      }

      const rItemRepo = manager.getCustomRepository(this.returnItemRepository_)
      returnObject.items = returnLines.map(i =>
        rItemRepo.create({
          item_id: i.id,
          quantity: i.quantity,
          requested_quantity: i.quantity,
          reason_id: i.reason_id,
          note: i.note,
          metadata: i.metadata,
          no_notification: data.no_notification,
        })
      )

      const created = await returnRepository.create(returnObject)
      const result = await returnRepository.save(created)

      if (method) {
        await this.shippingOptionService_
          .withTransaction(manager)
          .createShippingMethod(
            method.option_id,
            {},
            {
              price: method.price,
              return_id: result.id,
            }
          )
      }

      return result
    })
  }

  fulfill(returnId) {
    return this.atomicPhase_(async manager => {
      const returnOrder = await this.retrieve(returnId, {
        relations: [
          "items",
          "shipping_method",
          "shipping_method.shipping_option",
          "swap",
          "claim_order",
        ],
      })

      if (returnOrder.status === "canceled") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Cannot fulfill a canceled return"
        )
      }

      let returnData = { ...returnOrder }

      const items = await this.lineItemService_.list({
        id: returnOrder.items.map(({ item_id }) => item_id),
      })

      returnData.items = returnOrder.items.map(item => {
        const found = items.find(i => i.id === item.item_id)
        return {
          ...item,
          item: found,
        }
      })

      if (returnOrder.shipping_data) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Return has already been fulfilled"
        )
      }

      if (returnOrder.shipping_method === null) {
        return returnOrder
      }

      const fulfillmentData = await this.fulfillmentProviderService_.createReturn(
        returnData
      )

      returnOrder.shipping_data = fulfillmentData

      const returnRepo = manager.getCustomRepository(this.returnRepository_)
      const result = await returnRepo.save(returnOrder)
      return result
    })
  }

  /**
   * Registers a previously requested return as received. This will create a
   * refund to the customer. If the returned items don't match the requested
   * items the return status will be updated to requires_action. This behaviour
   * is useful in sitautions where a custom refund amount is requested, but the
   * retuned items are not matching the requested items. Setting the
   * allowMismatch argument to true, will process the return, ignoring any
   * mismatches.
   * @param {string} orderId - the order to return.
   * @param {string[]} lineItems - the line items to return
   * @return {Promise} the result of the update operation
   */
  async receive(returnId, receivedItems, refundAmount, allowMismatch = false) {
    return this.atomicPhase_(async manager => {
      const returnRepository = manager.getCustomRepository(
        this.returnRepository_
      )

      const returnObj = await this.retrieve(returnId, {
        relations: ["items", "swap", "swap.additional_items"],
      })

      if (returnObj.status === "canceled") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Cannot receive a canceled return"
        )
      }

      let orderId = returnObj.order_id
      // check if return is requested on a swap
      if (returnObj.swap) {
        orderId = returnObj.swap.order_id
      }

      const order = await this.orderService_
        .withTransaction(manager)
        .retrieve(orderId, {
          relations: [
            "items",
            "returns",
            "payments",
            "discounts",
            "discounts.rule",
            "discounts.rule.valid_for",
            "refunds",
            "shipping_methods",
            "region",
            "swaps",
            "swaps.additional_items",
          ],
        })

      if (returnObj.status === "received") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Return with id ${returnId} has already been received`
        )
      }

      const returnLines = await this.getFulfillmentItems_(
        order,
        receivedItems,
        this.validateReturnLineItem_
      )

      const newLines = returnLines.map(l => {
        const existing = returnObj.items.find(i => l.id === i.item_id)
        if (existing) {
          return {
            ...existing,
            quantity: l.quantity,
            requested_quantity: existing.quantity,
            received_quantity: l.quantity,
            is_requested: l.quantity === existing.quantity,
          }
        } else {
          return {
            return_id: returnObj.id,
            item_id: l.id,
            quantity: l.quantity,
            is_requested: false,
            received_quantity: l.quantity,
            metadata: l.metadata || {},
          }
        }
      })

      let returnStatus = "received"

      const isMatching = newLines.every(l => l.is_requested)
      if (!isMatching && !allowMismatch) {
        // Should update status
        returnStatus = "requires_action"
      }

      const totalRefundableAmount = refundAmount || returnObj.refund_amount

      const now = new Date()
      const updateObj = {
        ...returnObj,
        status: returnStatus,
        items: newLines,
        refund_amount: totalRefundableAmount,
        received_at: now.toISOString(),
      }

      const result = await returnRepository.save(updateObj)

      for (const i of returnObj.items) {
        const lineItem = await this.lineItemService_
          .withTransaction(manager)
          .retrieve(i.item_id)
        const returnedQuantity = (lineItem.returned_quantity || 0) + i.quantity
        await this.lineItemService_.withTransaction(manager).update(i.item_id, {
          returned_quantity: returnedQuantity,
        })
      }

      for (const line of newLines) {
        const orderItem = order.items.find(i => i.id === line.item_id)
        if (orderItem) {
          await this.inventoryService_
            .withTransaction(manager)
            .adjustInventory(orderItem.variant_id, line.received_quantity)
        }
      }

      return result
    })
  }
}

export default ReturnService
