# ADR-HUB-568: Native packs for Test and Await consumers

The previous consumer iterated over every intersecting pack or loose object.
It hashed both names of each hardlink and rechecked the owner before each link.
One live Await spent 419 seconds creating 542 names.

The existing object store passes the exact imported closure to Git once per
new durable consumer. Git builds one pack and index in the consumer using its
existing object data. This writes separate pack bytes. The consumer stays
readable after pool maintenance and has its own refs, index, config and worktree.

The existing import receipt, process guard, directory ownership, Git
connectivity and original completion still govern the result. An interrupted
consumer remains tied to its original operation. Existing captures keep their
stored representation. Archive restoration keeps its existing owner and path.
