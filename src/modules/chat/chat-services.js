const cassandra                 = require('../../../bootstrap/cassandra').client,
    cassandraDriver             = require('cassandra-driver'),
    {redis, redisKeys}          = require('../../utils/redis'),
    mongoCollections            = require('../../utils/mongo'),
    userServices                = require('../user/user-services'),
    constants                   = require('../../utils/constants'),
    logger                      = require('../../utils/logger'),
    universalFunc               = require('../../utils/universal-functions'),
    errify                      = require('../../utils/errify'),
    errMsg                      = require('../../utils/error-messages');

const createDefaultChannelForSP = async (serviceProviderId, serviceProvider) => {
    try {
        const channelExistsQuery= `SELECT conversation_id FROM conversations_by_time WHERE user_id = ? AND conversation_type = ?`
        const channelExistsCheck= await cassandra.execute(channelExistsQuery, [serviceProviderId, constants.conversationTypes.channel], {prepare: true, fetchSize: 1})
        if(channelExistsCheck.rowLength === 0) {
            const conversationId= cassandraDriver.types.TimeUuid.now()
            const spDefaultChannel = `
                INSERT INTO conversations (conversation_id, user_id, conversation_type, conversation_user_type,
                last_message_id, last_message_content, last_message_sender_id, last_message_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            const params        = [
                conversationId, serviceProviderId, constants.conversationTypes.channel, constants.userRoles.serviceProvider,
                conversationId, constants.defalutMessages.spAdminVerified(serviceProvider.name), serviceProviderId, constants.messageType.notificaiton
            ]
            await cassandra.execute(spDefaultChannel, params, {prepare: true})
            await redis.set(redisKeys.spDefaultChannel(serviceProviderId), conversationId.toString())
        }
    } catch (err) {
        console.log(err)
       // logger.error({message: err})
    }
}

const getServiceProviderDefaultChannelId = async serviceProviderId => {
    let channelId   = await redis.get(redisKeys.spDefaultChannel(serviceProviderId))
    if(channelId === null) {
        const query = `SELECT conversation_id FROM conversations_by_time WHERE user_id = ? AND conversation_type = ?`
        const result= await cassandra.execute(query, [serviceProviderId, constants.conversationTypes.channel], {prepare: true})
        channelId   = result.rows[0].conversation_id.toString()
        await redis.set(redisKeys.spDefaultChannel(serviceProviderId), channelId)
    }
    return channelId
}

const getServiceProviderDefaultChannel  = async serviceProviderId => {
    const query     = `SELECT * FROM conversations_by_time WHERE user_id = ? AND conversation_type = ?`;
    const channelRes= await cassandra.execute(query, [serviceProviderId, constants.conversationTypes.channel], {prepare: true})
    return channelRes.rows[0]
}

const getConversationBetweenTwoUsers= (userId, otherUserId) => {
    const query     = `SELECT * FROM conversation_by_pairs WHERE user_id = ? AND other_user_id = ? AND conversation_type= ?`;
    const params    = [userId, otherUserId, constants.conversationTypes.single];
    return cassandra.execute(query, params, {prepare: true});
}

const createConversationBetweenTwoUsers = async (requestedUser, otherUserId) => {
    const userId    = requestedUser.userId, userType = requestedUser.role;
    const otherUserType = userType === constants.userRoles.customer ? constants.userRoles.serviceProvider : constants.userRoles.customer;
    const collection= otherUserType === constants.userRoles.customer ? mongoCollections.customers : mongoCollections.serviceproviders;
    const otherUser = await mongodb.collection(collection).findOne({_id: universalFunc.mongoUUID(otherUserId)}, {_id: 1});
    if(!otherUser)
        throw errify.notFound(errMsg['1017'], 1017)
    const conversationId    = cassandraDriver.types.TimeUuid.now(), conversationType = constants.conversationTypes.single;
    const query     = `INSERT INTO conversations (conversation_id, user_id, other_user_id, conversation_type, conversation_user_type) VALUES (?, ?, ?, ?, ?)`;
    const queries   = [
        {query, params: [conversationId, userId, otherUserId, conversationType, userType]},
        {query, params: [conversationId, otherUserId, userId, conversationType, otherUserType]}
    ]
    await cassandra.batch(queries, {prepare: true});
    return {
        conversation_id: conversationId, user_id: userId, other_user_id: otherUserId, conversation_type: conversationType,
        conversation_user_type: userType, is_blocked: false, is_other_user_blocked: false,
        last_message_id: null, last_message_content: null, last_message_sender_id: null, last_message_type: null
    }
}

const getConversationById           = (conversationId, userId) => {
    const query     = `SELECT * FROM conversations WHERE conversation_id = ? AND user_id = ?`
    const params    = [conversationId, userId]
    return cassandra.execute(query, params, {prepare: true})
}

const getConversationsBlockStatus   = async conversations => {
    const query     = `SELECT conversation_id, is_blocked from conversations WHERE conversation_id = ? AND user_id = ?`;
    const requests  = conversations.reduce((req, conversation) => {
        if(conversation.other_user_id) 
            req.push(cassandra.execute(query, [conversation.conversation_id, conversation.other_user_id], {prepare: true}));
        return req
    }, []);
    const results   = requests.length ? await Promise.all(requests) : []
    const conversationBlocked = new Map();
    results.forEach(result => conversationBlocked.set(result.rows[0].conversation_id.toString(), result.rows[0].blocked));
    return conversationBlocked;
}

const getUnreadCount            = async (userId, conversationId) => {
    const query     = `SELECT conversation_id, unread FROM unread_count WHERE conversation_id = ? AND user_id = ?`;
    const count     = await cassandra.execute(query, [conversationId, userId], {prepare: true});
    return count.rowLength ? parseInt(count.rows[0].unread) : 0;
}

const getUnreadCounts           = (userId, conversationIds) => Promise.all(conversationIds.map(id => getUnreadCount(userId, id)))

const getMessages               = (conversationId, fetchSize=20, pageState, lastMessageId) => {
    let query       = `SELECT message_id, toTimestamp(message_id) as message_time, content, message_type, sender_id, sender_type, is_deleted FROM message WHERE conversation_id = ?`
    const params    = [conversationId]
    if(lastMessageId){
        query       += ` AND message_id < ?`
        params.push(lastMessageId)
    }
    return cassandra.execute(query, params, {fetchSize, pageState, prepare: true})
}

const getMessagesAcknowlegements= async (conversationId, messageIds) => {
    const query     = `SELECT message_id, COUNT(is_delivered) as delivered_count, COUNT(is_seen) as seen_count
        FROM message_acknowledgement_status WHERE conversation_id = ? AND message_id IN ? GROUP BY message_id`;
    const result    = await cassandra.execute(query, [conversationId, messageIds], {prepare: true})
    return result.rows.reduce((map, row) => {map.set(row.message_id.toString(), row); return map;}, new Map())
}

const changeBlockStatusByConversationId = async (conversationId, userId, block) => {
    const convoQuery= `SELECT conversation_type, other_user_id, is_blocked FROM conversations WHERE conversation_id =? AND user_id = ?`
    const conversationResult    = await cassandra.execute(convoQuery, [conversationId, userId], {prepare: true})
    if(conversationResult.rowLength && conversationResult.rows[0].conversation_type === constants.conversationTypes.single) {
        const {other_user_id: otherUserId} = conversationResult.rows[0]
        const blockUpdateQuery  = `UPDATE conversations SET is_blocked = ? WHERE conversation_id = ? AND user_id = ? AND conversation_type = ?`
        const params            = [block, conversationId, otherUserId, constants.conversationTypes.single]
        await cassandra.execute(blockUpdateQuery, params, {prepare: true})
        // await userServices.expireUserConversationsCached(userId)
    }
}

const clearUnreadCount          = async (conversationId, userId) => {
    const currentUnreadCount    = await getUnreadCount(userId, conversationId)
    if (currentUnreadCount !== 0) {
        const query             = 'UPDATE unread_count SET unread = unread - ? WHERE conversation_id = ? AND user_id = ?'
        const params            = [currentUnreadCount, conversationId, userId]
        return cassandra.execute(query, params, {prepare: true})
    }
}

module.exports                  = {
    createDefaultChannelForSP,
    getServiceProviderDefaultChannelId,
    getServiceProviderDefaultChannel,
    getConversationBetweenTwoUsers,
    createConversationBetweenTwoUsers,
    getConversationById,
    getConversationsBlockStatus,
    getUnreadCount,
    getUnreadCounts,
    getMessages,
    getMessagesAcknowlegements,
    changeBlockStatusByConversationId,
    clearUnreadCount
}